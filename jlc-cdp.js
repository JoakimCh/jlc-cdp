
import {spawn} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {WebSocket} from 'jlc-websocket'

const debug = (text, value) => {
  if (value != undefined) {
    console.log(text+': ')
    console.dir(value, {depth: null, colors: true})
  } else {
    console.log(text)
  }
}

class CDP_Error extends Error {
  constructor({message, code, data}, rpc) {
    const cause = {...rpc}
    delete cause.id
    if (cause.sessionId == undefined) delete cause.sessionId
    if (data) message += ': '+data
    super(message, {cause})
    this.name = this.constructor.name
    this.code = code
    delete this.stack// = undefined
  }
}

/** Listen to `Target.detachedFromTarget` to know if the session has been detached. */
class CDP_Session extends EventEmitter {
  #cdp; #sessionId; #targetId
  ready

  get id() {return this.#sessionId}
  get targetId() {return this.#targetId}

  constructor(cdp, {params, targetId}) {
    super()
    this.#cdp = cdp
    this.ready = new Promise((resolve, reject) => {
      // setTimeout(() => { // probably not needed
        this.#initSession(params, targetId, resolve, reject)
      // }, 1)
    })
  }

  async #initSession(params, targetId, resolve, reject) {
    try {
      if (params) {
        const result = await this.#cdp.send('Target.createTarget', params)
        if (!result.targetId) {
          return reject(Error('Error creating new session: '+result))
        }
        targetId = result.targetId
      }
      const result = await this.#cdp.send('Target.attachToTarget', {
        targetId, flatten: true
      })
      const {sessionId} = result
      if (!sessionId) {
        return reject(Error('Error creating new session: '+result))
      }
      this.#targetId = targetId
      this.#sessionId = sessionId
      resolve({sessionId, targetId}) // resolve the this.ready promise
      // this.emit('ready', {sessionId, targetId}) // also emit a ready event
      this.once('Target.detachedFromTarget', () => {
        this.#sessionId = null
        this.emit('detached', {sessionId, targetId})
        setTimeout(() => {
          this.removeAllListeners()
        }, 1)
      })
    } catch (error) {
      reject(error)
    }
  }

  /** Send a command which includes the `sessionId` parameter of this session. */
  send(method, params = undefined) {
    if (!this.#sessionId) throw Error(`A session that has been detached from its target (or not yet been attached) must not be used. The "ready" promise and the "detached" event will help you keep track of this.`)
    return this.#cdp.send(method, params, this.#sessionId)
  }

  async sendWithRetry(method, params = undefined, maxRetries = 3, retryDelay = 100) {
    return this.#cdp.sendWithRetry(method, params, this.#sessionId, maxRetries, retryDelay)
  }

  /** Returns a readable stream (Web API) which can be used to read a CDP stream by its handle. */
  readStream(handle, {offset, chunkSize} = {}) {
    return this.#cdp.readStream(handle, {offset, chunkSize}, this.#sessionId)
  }

  /** Detach this session from its target. */
  detach() {
    return this.#cdp.send('Target.detachFromTarget', {sessionId: this.#sessionId})
  }

  /** Eval using Runtime.evaluate on the session target, can not be blocked by CSP. Will throw on exception. */
  eval(code, config = {}) {
    return this.#cdp.eval(code, config, this.#sessionId)
  }
}

/** A bare bones implementation of Chrome DevTools/Debugging Protocol. */
export class ChromeDevToolsProtocol extends EventEmitter {
  debug
  debug_skipParams
  #ws; #msgId = 0
  #awaitingReply = new Map()
  #attachedSessions = new Map()
  ready

  constructor({webSocketDebuggerUrl, debug = false, debug_skipParams = false}) {
    super()
    this.debug = debug
    this.debug_skipParams = debug_skipParams
    this.#ws = new WebSocket(webSocketDebuggerUrl)
    this.#ws.jsonMode = true
    this.#ws.on('message', this.#msgHandler.bind(this))
    this.#ws.once('close', event => this.emit('close', event))
    this.#ws.once('error', event => this.emit('error', event))
    this.ready = new Promise(resolve => {
      this.#ws.once('open', resolve)
    })
  }

  /** Creates a new session and binds it to a target (which is newly created if not specified). Specify `params` to create a new target, e.g. `{url}` OR `targetId`. Wait for ready before using it. */
  newSession({params, targetId}) {
    if ((params && targetId) || (!params && !targetId)) throw Error(`Either supply 'params' (e.g. {url}) to create a new target for the session or a 'targetId' to attach the session to.`)
    const session = new CDP_Session(this, {params, targetId})
    session.ready.then(({sessionId}) => {
      this.#attachedSessions.set(sessionId, session)
    }).catch(() => {}) // even if caught elsewhere we must also catch it here!!
    session.once('detached', ({sessionId}) => {
      this.#attachedSessions.delete(sessionId)
    })
    return session
  }

  /** Send a command not bound to any session (unless `sessionId` is specified). */
  send(method, params = undefined, sessionId = undefined) {
    const id = this.#msgId ++
    // anything undefined is ignored by JSON.stringify
    const rpc = {id, method, params, sessionId}
    if (this.debug) debug('Outgoing RPC', rpc)
    this.#ws.send(rpc)
    return this.#getReply(rpc)
  }

  async sendWithRetry(method, params = undefined, sessionId = undefined, maxRetries = 3, retryDelay = 100) {
    let retries = 0
    while (true) {
      try {
        return await this.send(method, params, sessionId)
      } catch (error) {
        if (retries++ == maxRetries) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      }
    }
  }

  readStream(handle, {offset, chunkSize} = {}, sessionId = undefined) {
    const send = this.send.bind(this)
    return new ReadableStream({
      async pull(controller) {
        const {data, base64Encoded, eof} = await send('IO.read', {handle, offset, size: chunkSize}, sessionId)
        if (offset) offset = undefined
        if (data) {
          controller.enqueue({data, base64Encoded})
        }
        if (eof) {
          controller.close()
          await send('IO.close', {handle}, sessionId)
        }
      }
    })
  }

  async eval(code, config = {}, sessionId = undefined) {
    const options = {
      replMode: true,
      ...config,
      returnByValue: true, // then objects are returned without having to be fetched by id
    }
    const {result: {type, value}, exceptionDetails} = await this.send('Runtime.evaluate', {
      ...options,
      expression: code
    }, sessionId)
    if (exceptionDetails) throw exceptionDetails
    return value
  }

  /** Close the connection. */
  close() {
    this.#ws.close()
  }

  #getReply(rpc) {
    return new Promise((resolve, reject) => {
      this.#awaitingReply.set(rpc.id, {resolve, reject, rpc})
    })
  }

  /** Get an active session instance with this `sessionId`, returns `undefined` if there is none. */
  getSession(sessionId) {
    return this.#attachedSessions.get(sessionId)
  }

  #msgHandler({data}) {
    if ('id' in data) {
      if (this.debug) debug('Incoming result', data)
      const {id, result, error} = data
      const promise = this.#awaitingReply.get(id)
      if (promise) {
        this.#awaitingReply.delete(id)
        if (result) {
          promise.resolve(result)
        } else {
          promise.reject(new CDP_Error(error, promise.rpc))
        }
      } else {
        throw Error('Id not awaiting result, but got one: '+id+', '+data)
      }
    } else if ('method' in data) {
      let {method, params, sessionId} = data
      if (this.debug) {
        if (this.debug_skipParams && data.params) {
          const toDebug = {...data}
          delete toDebug.params
          debug('Incoming event', toDebug)
        } else {
          debug('Incoming event', data)
        }
      }
      this.emit(method, params, sessionId)
      if (!sessionId && params?.sessionId) {
        // have the session emit events related to it, e.g. Target.detachedFromTarget
        sessionId = params.sessionId
      }
      if (sessionId) {
        const session = this.#attachedSessions.get(sessionId)
        if (session) {
          session.emit(method, params)
        }
      }
    } else throw Error('Message without id or method received: '+data)
  }
}

export async function initChrome({chromiumPath, cdpPort = 9222, detached = true, chromiumArgs = []}) {
  const controller = new AbortController()
  const signal = controller.signal
  const timeout = setTimeout(() => controller.abort(), 4000)
  let chrome
  while (true) {
    try {
      if (chrome) { // if we just tried to launched it
        const stderr = await new Promise((resolve, reject) => {
          let output = ''
          signal.onabort = () => resolve('Abort signal triggered.')
          chrome.once('error', reject)
          const stderrHandler = text => {
            output += text
            if (output.includes('DevTools listening on')) {
              chrome.stderr.off('data', stderrHandler)
              resolve(output)
            }
          }
          chrome.stderr.on('data', stderrHandler)
        })
        if (!stderr.includes('DevTools listening on')) {
          throw Error(`Error enabling DevTools: ${stderr}`)
        }
      }
      const result = {
        chrome,
        info: await (await fetch(`http://localhost:${cdpPort}/json/version`, {signal})).json()
      }
      clearTimeout(timeout)
      return result
    } catch (error) {
      if (chrome) {
        throw Error(`Can't connect to the DevTools protocol. Is the browser already running without the debugging port enabled?`, {cause: error})
      }
      chrome = spawn(chromiumPath, [`--remote-debugging-port=${cdpPort}`, ...chromiumArgs], {
        detached // let it continue to run when we're done?
      })
      chrome.stderr.setEncoding('utf-8')
    }
  }
}

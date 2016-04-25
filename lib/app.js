var debug = require('debug')('telegraf:core')
var compose = require('koa-compose')
var fetch = require('node-fetch')
var EventEmitter = require('events').EventEmitter
var FormData = require('form-data')
var fs = require('fs')
var ware = require('co-ware')
var https = require('https')

var matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g

var messageSubTypes = [
  'text',
  'audio',
  'document',
  'photo',
  'sticker',
  'video',
  'voice',
  'contact',
  'location',
  'venue',
  'new_chat_participant',
  'left_chat_participant',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message'
]

var shortcuts = [
  { name: 'reply', target: 'sendMessage' },
  { name: 'replyWithPhoto', target: 'sendPhoto' },
  { name: 'replyWithAudio', target: 'sendAudio' },
  { name: 'replyWithDocument', target: 'sendDocument' },
  { name: 'replyWithSticker', target: 'sendSticker' },
  { name: 'replyWithVideo', target: 'sendVideo' },
  { name: 'replyWithVoice', target: 'sendVoice' },
  { name: 'replyWithChatAction', target: 'sendChatAction' },
  { name: 'replyWithLocation', target: 'sendLocation' }
]

var telegraf = Telegraf.prototype
module.exports = Telegraf

function Telegraf (token) {
  if (!(this instanceof Telegraf)) {
    return new Telegraf(token)
  }
  this.token = token
  this.middleware = []
  this.offset = 0
  this.started = false
  this.options = {}
  this.context = {}
  this.bus = new EventEmitter()
}

telegraf.startPolling = function (timeout, limit) {
  this.started = true
  this.options.timeout = timeout || 0
  this.options.limit = limit || 100
  this.updateLoop()
  return this
}

telegraf.startWebHook = function (token, tlsOptions, port, host) {
  this.started = true
  if (!tlsOptions) {
    throw new Error('tlsOptions required')
  }
  var self = this
  this.webhookServer = https.createServer(tlsOptions, function (req, res) {
    if (req.method !== 'POST' || req.url !== `/${token}`) {
      res.statusCode = 403
      res.end()
    }
    res.writeHead(200)
    var body = ''
    req.on('data', function (chunk) {
      body += chunk.toString()
    })
    req.on('end', function () {
      try {
        var update = JSON.parse(body)
        self.handleUpdate(update)
      } catch (error) {
        self.onerror(error)
      }
      res.end('OK')
    })
  }).listen(port, host)
  return this
}

telegraf.stop = function () {
  this.started = false
  if (this.webhookServer) {
    this.webhookServer.close()
  }
  return this
}

telegraf.use = function (fn) {
  this.middleware.push(fn)
  return this
}

telegraf.onerror = function (err) {
  var msg = err.stack || err.toString()
  console.error()
  console.error(msg.replace(/^/gm, '  '))
  console.error()
}

telegraf.on = function (eventType) {
  var fns = [].slice.call(arguments, 1)
  this.bus.on(eventType, function (payload) {
    var context = this.createContext(eventType, payload)
    context.use(compose(this.middleware))
    context.use(compose(fns))
    context.on('error', this.onerror)
    context.run()
  }.bind(this))
  return this
}

telegraf.hears = function (regex) {
  if (typeof regex === 'string') {
    regex = new RegExp(regex.replace(matchOperatorsRe, '\\$&'))
  }
  var fn = compose([].slice.call(arguments, 1))
  this.on('text', function * () {
    if (!this.message.text) {
      return
    }
    var result = regex.exec(this.message.text)
    if (result) {
      this.__defineGetter__('match', function () {
        return result || []
      })
      yield fn
    }
  })
  return this
}

telegraf.getUpdates = function (timeout, limit, offset) {
  return this.sendRequest(`getUpdates?offset=${offset}&limit=${limit}&timeout=${timeout}`)
}

telegraf.getMe = function () {
  return this.sendRequest('getMe')
}

telegraf.getFile = function (fileId) {
  return this.sendRequest('getFile', {file_id: fileId})
}

telegraf.getFileLink = function (fileId) {
  return this.getFile(fileId)
    .then(function (response) {
      return `https://api.telegram.org/file/bot${this.token}/${response.file_path}`
    }.bind(this))
}

telegraf.setWebHook = function (url, cert) {
  var options = {
    url: url,
    certificate: {source: cert}
  }
  return this.sendRequest('setWebHook', options)
}

telegraf.removeWebHook = function () {
  return this.sendRequest('setWebHook', { url: '' })
}

telegraf.sendMessage = function (chatId, text, extra) {
  var options = {
    chat_id: chatId,
    text: text
  }
  return this.sendRequest('sendMessage', Object.assign(options, extra))
}

telegraf.forwardMessage = function (chatId, fromChatId, messageId, extra) {
  var options = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  }
  return this.sendRequest('forwardMessage', Object.assign(options, extra))
}

telegraf.sendChatAction = function (chatId, action) {
  var options = {
    chat_id: chatId,
    action: action
  }
  return this.sendRequest('sendChatAction', options)
}

telegraf.getUserProfilePhotos = function (userId, offset, limit) {
  var options = {
    user_id: userId,
    offset: offset,
    limit: limit
  }
  return this.sendRequest('getUserProfilePhotos', options)
}

telegraf.sendLocation = function (chatId, latitude, longitude, extra) {
  var options = {
    chat_id: chatId,
    latitude: latitude,
    longitude: longitude
  }
  return this.sendRequest('sendLocation', Object.assign(options, extra))
}

telegraf.answerInlineQuery = function (inlineQueryId, results, extra) {
  var options = {
    inline_query_id: inlineQueryId,
    results: JSON.stringify(results)
  }
  return this.sendRequest('answerInlineQuery', Object.assign(options, extra))
}

telegraf.sendPhoto = function (chatId, photo, extra) {
  var options = {
    chat_id: chatId,
    photo: {source: photo}
  }
  return this.sendRequest('sendPhoto', Object.assign(options, extra))
}

telegraf.sendDocument = function (chatId, doc, extra) {
  var options = {
    chat_id: chatId,
    document: {source: doc}
  }
  return this.sendRequest('sendDocument', Object.assign(options, extra))
}

telegraf.sendAudio = function (chatId, audio, extra) {
  var options = {
    chat_id: chatId,
    audio: {source: audio}
  }
  return this.sendRequest('sendAudio', Object.assign(options, extra))
}

telegraf.sendSticker = function (chatId, sticker, extra) {
  var options = {
    chat_id: chatId,
    sticker: {source: sticker}
  }
  return this.sendRequest('sendSticker', Object.assign(options, extra))
}

telegraf.sendVideo = function (chatId, video, extra) {
  var options = {
    chat_id: chatId,
    video: {source: video}
  }
  return this.sendRequest('sendVideo', Object.assign(options, extra))
}

telegraf.sendVoice = function (chatId, voice, extra) {
  var options = {
    chat_id: chatId,
    voice: {source: voice}
  }
  return this.sendRequest('sendVoice', Object.assign(options, extra))
}

telegraf.kickChatMember = function (chatId, userId) {
  var options = {
    chat_id: chatId,
    userId: userId
  }
  return this.sendRequest('kickChatMember', options)
}

telegraf.unbanChatMember = function (chatId, userId) {
  var options = {
    chat_id: chatId,
    userId: userId
  }
  return this.sendRequest('unbanChatMember', options)
}

telegraf.answerCallbackQuery = function (callbackQueryId, text, showAlert) {
  var options = {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  }
  return this.sendRequest('answerCallbackQuery', options)
}

telegraf.editMessageText = function (chatId, messageId, text, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    text: text
  }
  return this.sendRequest('editMessageText', Object.assign(options, extra))
}

telegraf.editMessageCaption = function (chatId, messageId, caption, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    caption: caption
  }
  return this.sendRequest('editMessageCaption', Object.assign(options, extra))
}

telegraf.editMessageReplyMarkup = function (chatId, messageId, markup, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: markup
  }
  return this.sendRequest('editMessageReplyMarkup', Object.assign(options, extra))
}

telegraf.sendRequest = function (path, options) {
  if (!this.token) {
    throw new Error('Telegram Bot Token is required')
  }
  var payload
  if (!options) {
    payload = { method: 'GET' }
  } else {
    options = options || {}
    if (options.reply_markup && typeof options.reply_markup !== 'string') {
      options.reply_markup = JSON.stringify(options.reply_markup)
    }
    var form = new FormData()
    Object.keys(options).forEach(function (key) {
      var value = options[key]
      if (typeof value === 'undefined' || value == null) {
        return
      }
      if (typeof value === 'object') {
        var data = value.source
        if (data) {
          if (Buffer.isBuffer(data)) {
            form.append(key, data, {
              knownLength: data.length
            })
          } else if (fs.existsSync(data)) {
            form.append(key, fs.createReadStream(data), {
              knownLength: fs.statSync(data).size
            })
          } else {
            form.append(key, data)
          }
        }
      } else if (typeof value === 'boolean') {
        form.append(key, value.toString())
      } else {
        form.append(key, value)
      }
    })
    payload = { method: 'POST', body: form }
  }
  debug('fetch', `https://api.telegram.org/bot${this.token}/${path}`)
  return fetch(`https://api.telegram.org/bot${this.token}/${path}`, payload)
    .then(function (res) {
      return res.json()
    })
    .then(function (data) {
      if (data.ok) {
        return data.result
      } else {
        throw new Error(`${data.error_code}: ${data.description}`)
      }
    })
}

telegraf.handleUpdate = function (update) {
  var bus = this.bus
  var offset = update.update_id + 1
  debug(update)
  Object.keys(update).forEach(function (key) {
    bus.emit(key, update[key])
  })
  if (update.message) {
    messageSubTypes.forEach(function (messageType) {
      if (update.message[messageType]) {
        bus.emit(messageType, update.message)
      }
    })
  }
  this.offset = offset
}

telegraf.updateLoop = function () {
  if (!this.started) {
    return
  }
  var handleUpdate = this.handleUpdate.bind(this)
  var updateLoop = this.updateLoop.bind(this)
  var errorHandler = this.onerror.bind(this)
  this.getUpdates(this.options.timeout, this.options.limit, this.offset)
    .then(function (updates) {
      updates.forEach(handleUpdate)
      updateLoop()
    })
    .catch(function (err) {
      debug('pooling error', err)
      errorHandler(err)
      updateLoop()
    })
}

telegraf.createContext = function (payloadType, payload) {
  var state = {}
  var context = Object.assign({}, this.context)
  context.__defineGetter__('eventType', function () {
    return payloadType
  })
  if (payloadType === 'message' || messageSubTypes.indexOf(payloadType) !== -1) {
    shortcuts.forEach(function (shortcut) {
      context[shortcut.name] = this[shortcut.target].bind(this, payload.chat.id)
    }.bind(this))
    context.__defineGetter__('message', function () {
      return payload
    })
  } else if (payloadType === 'callback_query') {
    shortcuts.forEach(function (shortcut) {
      context[shortcut.name] = this[shortcut.target].bind(this, payload.message.chat.id)
    }.bind(this))
    context.__defineGetter__('callbackQuery', function () {
      return payload
    })
  } else if (payloadType === 'inline_query') {
    context.__defineGetter__('inlineQuery', function () {
      return payload
    })
  } else if (payloadType === 'chosen_inline_result') {
    context.__defineGetter__('chosenInlineResult', function () {
      return payload
    })
  }
  context.__defineGetter__('state', function () {
    return state
  })
  context.__defineSetter__('state', function (val) {
    state = Object.assign({}, val)
  })
  var ctx = ware()
  ctx.context = context
  return ctx
}
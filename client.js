/**
 * dsh-plugin-conversation-delete — Client half.
 *
 * 手写的懒 CJS 工厂（与 DSH 打包器产出的形态一致），所以独立插件不需要构建步骤：
 * 执行这个文件只注册一个 factory，所有副作用都发生在 factory 内、在插件激活时运行。
 *
 * 贡献两个槽位，共用一个「当前请求」store：
 *
 *   - `sidebar.workspaces.session.menu.item` —— 四行菜单项：
 *       410 导出对话 / 420 打开文件位置 / 430 导入对话… / 500 删除对话（危险色，放最后）
 *     菜单项**和它所在的菜单一起被卸载**，所以这里只负责“发起请求”。
 *   - `shell.overlay` —— 跨栏浮层里的对话框（确认删除 / 导入 / 提示），它不随菜单消失。
 *
 * 导出优先走宿主自带的下载控制器（`sessionLogDownload`，产出带附件与子代理后代的规范 ZIP），
 * 拿不到它才退回到本插件的 `/export` 路由（原始 artifact 字节）。两者都能被本插件的导入吃回去。
 *
 * @module dsh-plugin-conversation-delete/client
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-conversation-delete',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      var React = require('react')

      var h = React.createElement

      /** Locale namespace owned by this plugin. */
      var NS = 'conversation-delete'
      /** The Session row's "..." menu. */
      var MENU_SLOT = 'sidebar.workspaces.session.menu.item'
      /**
       * 侧边栏底部的全局动作区（Settings 旁边那一行）。
       * 「导入对话」是全局动作，挂在某条对话的右键菜单里不合逻辑，所以放这里。
       */
      var FOOTER_SLOT = 'sidebar.footer.action'
      /** Frame-wide floating layer, above every column: where the dialogs live. */
      var OVERLAY_SLOT = 'shell.overlay'
      /** Host routes owned by this plugin. */
      var DELETE_URL = '/conversation-delete/delete'
      var EXPORT_URL = '/conversation-delete/export'
      var IMPORT_URL = '/conversation-delete/import'
      var REVEAL_URL = '/conversation-delete/reveal'
      var MOVE_URL = '/conversation-delete/move'
      var STYLE_TAG_ID = 'dsh-plugin-conversation-delete/styles'
      /** What the import file picker accepts. */
      var IMPORT_ACCEPT = '.zip,.jsonl,.zstd'

      var zh = {
        'menu.exportConversation': '导出对话',
        'menu.revealConversation': '打开文件位置',
        'menu.moveConversation': '更换工作区…',
        'menu.importConversation': '导入对话…',
        'menu.deleteConversation': '删除对话',
        'confirm.title': '删除这个对话？',
        'confirm.desc': '“{title}”将从列表中移除，且无法恢复。',
        'confirm.note': '该对话的聊天记录与其自己磁盘上的会话文件都会被删除；工作目录里的文件不受影响。',
        'confirm.action': '删除',
        'confirm.pending': '正在删除…',
        'import.title': '导入对话',
        'import.desc': '选择一个导出的对话文件。支持 DSH 自己导出的 .zip、规范 .jsonl，以及本插件导出的 .jsonl.zstd。',
        'import.pick': '选择文件…',
        'import.pending': '正在导入…',
        'import.done': '导入完成',
        'import.summary': '新会话 ID：{id}',
        'import.meta': '来源格式 {kind}；事件 {events} 行；写入 {bytes} 字节',
        'import.reIded': '（原 ID 已被占用，已分配新 ID）',
        'import.restored': '附件已还原：图片 {media} 个，文件 {files} 个。',
        'import.skipped': '有 {count} 个条目未还原（例如子代理记录）。',
        'import.tornTail': '注意：源文件的最后一帧已损坏，已按崩溃恢复语义丢弃该帧。',
        'import.refreshHint': '对话已写入，现在可以在会话列表里看到它。',
        'move.title': '把这条对话移到哪个工作区？',
        'move.desc': '工作区归属由会话的工作目录（cwd）决定，所以移动会同时改写它的 cwd，并把会话文件搬到该工作区的目录下。',
        'move.pending': '正在移动…',
        'move.done': '已移动',
        'move.summary': '“{title}”现在属于工作区「{workspace}」',
        'move.location': '会话文件新位置：{path}',
        'move.current': '当前所在',
        'move.already': '这条对话已经在该工作区里，无需移动。',
        'move.empty': '还没有别的工作区 —— 直接点下面的「选择目录…」指定一个位置就行。',
        'move.pick': '选择目录…',
        'move.pickHint': '也可以直接选一个目录：会为它建立（或复用）一个工作区，然后把这条对话搬过去。',
        'move.currentDir': '当前目录：{path}',
        'move.noPicker': '这个组合里没有目录选择器（uiWorkspace.pickDirectory 不可用）。',
        'move.noCreate': '这个组合里不能建立工作区（workspaces.create 不可用）。',
        'move.noWorkspace': '为该目录建立工作区后没有拿到 id。',
        'notice.title': '无法打开文件位置',
        'notice.path': '对话文件路径：',
        'copy': '复制路径',
        'copied': '已复制',
        'cancel': '取消',
        'close': '关闭',
        'confirmClose': '关闭对话框',
        'error.prefix': '操作失败：{message}'
      }

      var en = {
        'menu.exportConversation': 'Export conversation',
        'menu.revealConversation': 'Show file location',
        'menu.moveConversation': 'Move to workspace…',
        'menu.importConversation': 'Import conversation…',
        'menu.deleteConversation': 'Delete conversation',
        'confirm.title': 'Delete this conversation?',
        'confirm.desc': '"{title}" will be removed from the list and cannot be recovered.',
        'confirm.note': "The chat record and this conversation's own session files on disk are deleted. Files in the working directory are not affected.",
        'confirm.action': 'Delete',
        'confirm.pending': 'Deleting…',
        'import.title': 'Import a conversation',
        'import.desc': "Pick an exported conversation file. DSH's own .zip export, canonical .jsonl, and this plugin's .jsonl.zstd are all accepted.",
        'import.pick': 'Choose file…',
        'import.pending': 'Importing…',
        'import.done': 'Import finished',
        'import.summary': 'New session id: {id}',
        'import.meta': 'Source format {kind}; {events} event lines; wrote {bytes} bytes',
        'import.reIded': ' (the original id was taken, so a new one was assigned)',
        'import.restored': 'Attachments restored: {media} image(s), {files} file(s).',
        'import.skipped': '{count} archive entr(y/ies) were not restored (subagent transcripts, for example).',
        'import.tornTail': 'Note: the source file had a torn final frame, which was dropped as crash recovery.',
        'import.refreshHint': 'The conversation is written and should now appear in the session list.',
        'move.title': 'Move this conversation to which workspace?',
        'move.desc': "A workspace owns the sessions whose working directory (cwd) is its path, so moving also rewrites the cwd and relocates the conversation's file into that workspace's directory.",
        'move.pending': 'Moving…',
        'move.done': 'Moved',
        'move.summary': '"{title}" now belongs to the workspace "{workspace}"',
        'move.location': 'New conversation file location: {path}',
        'move.current': 'current',
        'move.already': 'This conversation is already in that workspace.',
        'move.empty': 'No other workspace yet — just use "Choose a folder…" below to point at one.',
        'move.pick': 'Choose a folder…',
        'move.pickHint': 'You can also pick a folder directly: a workspace is created (or reused) for it, then the conversation moves there.',
        'move.currentDir': 'Current directory: {path}',
        'move.noPicker': 'This composition has no directory picker (uiWorkspace.pickDirectory is unavailable).',
        'move.noCreate': 'This composition cannot create workspaces (workspaces.create is unavailable).',
        'move.noWorkspace': 'Creating a workspace for that folder returned no id.',
        'notice.title': 'Could not show the file location',
        'notice.path': 'Conversation file path:',
        'copy': 'Copy path',
        'copied': 'Copied',
        'cancel': 'Cancel',
        'close': 'Close',
        'confirmClose': 'Close dialog',
        'error.prefix': 'Failed: {message}'
      }

      /*
       * Class names are this plugin's own: the primitives' CSS-module hashes are
       * private build output, so the rows and dialogs restate the shipped markup
       * and rules under a `dshcd-` prefix. Only `--dsw-*` theme tokens are
       * referenced, so light and dark themes both apply.
       */
      var CSS = [
        '.dshcd-wrap{position:relative}',
        '.dshcd-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
        '.dshcd-wrap:first-child>.dshcd-sep:first-child{display:none}',
        '.dshcd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
        'border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;',
        'font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
        '.dshcd-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}',
        '.dshcd-item:disabled{opacity:.4;cursor:not-allowed}',
        '.dshcd-row-danger{color:var(--dsw-alias-state-error-primary)}',
        '.dshcd-row-danger .dshcd-icon{color:var(--dsw-alias-state-error-primary)}',
        '.dshcd-row-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
        '.dshcd-row-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
        '.dshcd-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;',
        'color:var(--dsw-alias-menu-icon)}',
        '.dshcd-icon svg{width:14px;height:14px}',
        '.dshcd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshcd-layer{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;',
        'pointer-events:auto;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
        '.dshcd-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);',
        'backdrop-filter:var(--dsw-mask-blur)}',
        '.dshcd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;',
        'width:min(420px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);',
        'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
        '.dshcd-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 6px 24px}',
        '.dshcd-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
        '.dshcd-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
        'border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
        'color:var(--dsw-alias-label-secondary)}',
        '.dshcd-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-desc{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
        '.dshcd-note{margin:0;padding:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.dshcd-error{margin:0;padding:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
        '.dshcd-ok{margin:0;padding:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
        '.dshcd-path{margin:0 24px;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
        'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);',
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;',
        'color:var(--dsw-alias-label-primary);word-break:break-all;user-select:text}',
        '.dshcd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
        '.dshcd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
        'height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-family:inherit;',
        'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}',
        '.dshcd-button:disabled{cursor:not-allowed;opacity:.4}',
        '.dshcd-outline{border:.5px solid var(--dsw-alias-border-l3)}',
        '.dshcd-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-button-danger{color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-state-error-primary)}',
        '.dshcd-button-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
        '.dshcd-hidden{display:none}',
        /* 侧边栏底部的全局动作（与 Settings 同一行区域，宽栏显示文字、窄栏只剩图标） */
        '.dshcd-footer-action{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:32px;',
        'padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
        'font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);text-align:left}',
        '.dshcd-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-footer-action:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}',
        '.dshcd-footer-icon{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center}',
        '.dshcd-footer-icon svg{width:16px;height:16px}',
        /* 工作区选择列表 */
        '.dshcd-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0 16px;max-height:260px;overflow:auto;',
        'list-style:none}',
        '.dshcd-ws{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:none;',
        'border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;font-family:inherit;',
        'text-align:left;color:var(--dsw-alias-label-primary)}',
        '.dshcd-ws:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-ws:disabled{cursor:default;opacity:.6}',
        '.dshcd-ws-title{font-size:13px;line-height:18px}',
        '.dshcd-ws-path{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      ].join('')

      /** Install this plugin's stylesheet once; the returned disposer removes it. */
      function insertStyles() {
        if (typeof document === 'undefined') return function () {}
        if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return function () {}
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-conversation-delete'
        tag.dataset.pluginCss = STYLE_TAG_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }

      /**
       * The one pending dialog request, shared by every menu row (writer) and the
       * overlay host (reader). `getSnapshot` keeps a stable reference between
       * writes, which is what `useSyncExternalStore` requires.
       */
      function createStore() {
        var value = null
        var seq = 0
        var listeners = new Set()
        var source = {
          getSnapshot: function () { return value },
          subscribe: function (listener) {
            listeners.add(listener)
            return function () { listeners.delete(listener) }
          },
        }
        function emit() {
          for (var listener of Array.from(listeners)) {
            try { listener() } catch (error) { console.error('conversation-delete: store listener failed', error) }
          }
        }
        return {
          source: source,
          open: function (request) {
            seq += 1
            value = Object.assign({}, request, { seq: seq })
            emit()
          },
          close: function () {
            value = null
            emit()
          },
        }
      }

      function TrashIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M3 4.5h10' }),
          h('path', { d: 'M6.4 4.5V3.4c0-.5.4-.9.9-.9h1.4c.5 0 .9.4.9.9v1.1' }),
          h('path', { d: 'M4.6 4.5l.5 8.2c.1.7.6 1.2 1.3 1.2h3.2c.7 0 1.2-.5 1.3-1.2l.5-8.2' }),
        )
      }

      function DownloadIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M8 2.6v7.2' }),
          h('path', { d: 'M5.2 7.2L8 10l2.8-2.8' }),
          h('path', { d: 'M2.8 12.4h10.4' }),
        )
      }

      function UploadIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M8 10.2V3' }),
          h('path', { d: 'M5.2 5.8L8 3l2.8 2.8' }),
          h('path', { d: 'M2.8 12.4h10.4' }),
        )
      }

      function FolderIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M2.4 4.6c0-.6.5-1 1-1h2.2l1.2 1.4h5.8c.6 0 1 .4 1 1v5.4c0 .6-.4 1-1 1H3.4c-.5 0-1-.4-1-1z' }),
        )
      }

      /** 「更换工作区」：一个箭头指进右侧目标位置的意象。 */
      function MoveIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M2.6 5.2c0-.5.4-.9.9-.9h1.9l1 1.2h5.1c.5 0 .9.4.9.9v4.6c0 .5-.4.9-.9.9H3.5c-.5 0-.9-.4-.9-.9z' }),
          h('path', { d: 'M11.4 7.6h2.6' }),
          h('path', { d: 'M12.9 6.1l1.5 1.5-1.5 1.5' }),
        )
      }

      function messageOf(reason) {
        return String(reason !== null && reason !== undefined && reason.message !== undefined ? reason.message : reason)
      }

      /** POST JSON and normalize the answer to `{ ok, status, body }` (never throws on a non-2xx). */
      function postJson(url, payload) {
        return window.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (response) {
          return response.json().catch(function () { return {} }).then(function (body) {
            return { ok: response.ok, status: response.status, body: body !== null && typeof body === 'object' ? body : {} }
          })
        })
      }

      /** Throw the report's own message when it says it failed; otherwise return it. */
      function expectOk(answer) {
        if (answer.ok === true && answer.body.ok === true) return answer.body
        var message = typeof answer.body.error === 'string' && answer.body.error !== '' ? answer.body.error : 'HTTP ' + String(answer.status)
        /*
         * 把 Host 记下的失败明细也带上。不然用户只会看到一句概括
         * （例如「搬迁未能验证，已回滚」），完全不知道是哪一步、为什么失败。
         */
        var failures = Array.isArray(answer.body.failures) ? answer.body.failures : []
        for (var index = 0; index < failures.length; index++) {
          var failure = failures[index]
          if (failure === null || failure === undefined) continue
          message += '\n· ' + String(failure.step) + ': ' + String(failure.error)
        }
        throw new Error(message)
      }

      /** Hand a Blob to the browser's download manager. */
      function saveBlob(blob, filename) {
        var url = URL.createObjectURL(blob)
        var anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(function () { URL.revokeObjectURL(url) }, 60000)
      }

      /**
       * Export one conversation.
       *
       * The shipped download controller is preferred: it streams DSH's own ZIP
       * (`GET /api/session.export`) including subagent descendants and attachment
       * payloads, so the file is exactly what the Session header's "Download
       * session log" produces. Only when that controller is absent does this fall
       * back to this plugin's own route, which returns the raw session artifact.
       *
       * @returns a Promise of a short description of what was produced.
       */
      function exportConversation(ctx, sessionId) {
        var controller = ctx.get('sessionLogDownload')
        if (controller !== undefined && controller !== null && typeof controller.download === 'function') {
          return Promise.resolve(controller.download(sessionId)).then(function () {
            return { via: 'host-zip' }
          })
        }
        return window.fetch(EXPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        }).then(function (response) {
          if (response.ok !== true) {
            return response.json().catch(function () { return {} }).then(function (body) {
              throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'HTTP ' + String(response.status))
            })
          }
          var suggested = response.headers.get('x-conversation-filename')
          return response.blob().then(function (blob) {
            var name = typeof suggested === 'string' && suggested !== '' ? suggested : 'dsh-session-' + sessionId + '.jsonl.zstd'
            saveBlob(blob, name)
            return { via: 'plugin-artifact', bytes: blob.size }
          })
        })
      }

      /** Delete one conversation: stop the work, delete the files, refresh the catalogue. */
      function performDelete(ctx, sessionId) {
        var sessions = ctx.get('sessions')
        var uiWorkspace = ctx.get('uiWorkspace')
        var stopped = Promise.resolve()
        if (uiWorkspace !== undefined && typeof uiWorkspace.archiveSession === 'function') {
          /*
           * The shipped archive action is reused rather than reimplemented: it asks
           * the Host to stop the Session's running work and clears the selection when
           * this was the open conversation. A refusal here is not fatal — the Host's
           * own delete route stops the work again.
           */
          stopped = Promise.resolve(uiWorkspace.archiveSession(sessionId, { stopActivity: true })).then(
            function () {},
            function (error) { console.warn('conversation-delete: archive before delete failed', error) },
          )
        }
        return stopped
          .then(function () { return new Promise(function (done) { window.setTimeout(done, 400) }) })
          .then(function () { return postJson(DELETE_URL, { sessionId: sessionId }) })
          .then(expectOk)
          .then(function (report) {
            if (sessions === undefined || typeof sessions.refresh !== 'function') return report
            return Promise.resolve(sessions.refresh()).then(function () { return report })
          })
      }

      /** Import one conversation file from raw bytes, then refresh the catalogue. */
      function performImport(ctx, buffer) {
        var sessions = ctx.get('sessions')
        return window.fetch(IMPORT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: buffer,
        }).then(function (response) {
          return response.json().catch(function () { return {} }).then(function (body) {
            return { ok: response.ok, status: response.status, body: body !== null && typeof body === 'object' ? body : {} }
          })
        }).then(expectOk).then(function (report) {
          if (sessions === undefined || typeof sessions.refresh !== 'function') return report
          return Promise.resolve(sessions.refresh()).then(function () { return report })
        })
      }

      /**
       * One menu row. The row dismisses the menu first — its subtree is unmounted
       * with the menu — and then runs the action it was created for.
       * @param spec - `{ labelKey, Icon, danger, separatorBefore, run(props) }`
       */
      function createActionRow(spec) {
        return function ActionRow(props) {
          var t = props.t
          var menu = props.useMenuOpenState()
          var setMenuOpen = menu[1]
          return h('div', { className: 'dshcd-wrap' },
            spec.separatorBefore === true && h('div', { className: 'dshcd-sep', role: 'separator' }),
            h('button', {
              type: 'button',
              role: 'menuitem',
              className: 'dshcd-item' + (spec.danger === true ? ' dshcd-row-danger' : ''),
              title: t(spec.labelKey),
              onClick: function () {
                setMenuOpen(false)
                spec.run(props)
              },
            },
              h('span', { className: 'dshcd-icon', 'aria-hidden': true }, h(spec.Icon, null)),
              h('span', { className: 'dshcd-label' }, t(spec.labelKey)),
            ),
          )
        }
      }

      /**
       * The shared dialog chrome: full-viewport layer, mask, centred card, header
       * with a close button, and a footer of buttons. Escape and a mask click both
       * close it while it is not busy.
       */
      function DialogShell(props) {
        var t = props.t
        var busy = props.busy === true
        var onClose = props.onClose
        var closeRef = React.useRef(null)

        React.useEffect(function () {
          if (closeRef.current !== null) closeRef.current.focus()
        }, [])

        React.useEffect(function () {
          var onKeyDown = function (event) {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            if (!busy) onClose()
          }
          document.addEventListener('keydown', onKeyDown, true)
          return function () { document.removeEventListener('keydown', onKeyDown, true) }
        }, [busy, onClose])

        var close = function () {
          if (busy) return
          onClose()
        }

        return h('div', { className: 'dshcd-layer' },
          h('div', { className: 'dshcd-mask', 'aria-hidden': true, onMouseDown: close }),
          h('div', {
            className: 'dshcd-dialog',
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'dshcd-title',
          },
            h('div', { className: 'dshcd-header' },
              h('h2', { className: 'dshcd-title', id: 'dshcd-title' }, props.title),
              h('button', {
                type: 'button',
                ref: closeRef,
                className: 'dshcd-close',
                'aria-label': t('confirmClose'),
                disabled: busy,
                onClick: close,
              }, '✕'),
            ),
            props.children,
            h('div', { className: 'dshcd-footer' }, props.footer),
          ),
        )
      }

      /** One dialog button; `variant` picks an extra class (`dshcd-outline` by default). */
      function DialogButton(props) {
        return h('button', {
          type: 'button',
          className: 'dshcd-button ' + (props.variant === undefined ? 'dshcd-outline' : props.variant),
          disabled: props.disabled === true,
          onClick: props.onClick,
        }, props.children)
      }

      /** The destructive confirmation. */
      function DeleteConfirmForm(props) {
        var request = props.request
        var t = props.t
        var [busy, setBusy] = React.useState(false)
        var [error, setError] = React.useState(null)
        var close = function () { if (!busy) props.store.close() }
        var confirm = function () {
          setBusy(true)
          setError(null)
          performDelete(props.ctx, request.sessionId).then(
            function () { setBusy(false); props.store.close() },
            function (reason) { setBusy(false); setError(messageOf(reason)) },
          )
        }
        var title = request.displayTitle !== '' && request.displayTitle !== undefined ? request.displayTitle : request.sessionId
        return h(DialogShell, {
          t: t,
          title: t('confirm.title'),
          busy: busy,
          onClose: close,
          footer: [
            h(DialogButton, { key: 'cancel', disabled: busy, onClick: close }, t('cancel')),
            h(DialogButton, { key: 'go', variant: 'dshcd-button-danger', disabled: busy, onClick: confirm }, busy ? t('confirm.pending') : t('confirm.action')),
          ],
        },
          h('p', { className: 'dshcd-desc' }, t('confirm.desc', { title: title })),
          h('p', { className: 'dshcd-note' }, t('confirm.note')),
          error !== null && h('p', { className: 'dshcd-error', role: 'alert' }, t('error.prefix', { message: error })),
        )
      }

      /** The import dialog: pick a file, upload it, report what was written. */
      function ImportDialog(props) {
        var t = props.t
        var ctx = props.ctx
        var [busy, setBusy] = React.useState(false)
        var [error, setError] = React.useState(null)
        var [result, setResult] = React.useState(null)
        var inputRef = React.useRef(null)
        var close = function () { if (!busy) props.store.close() }

        var onPick = function (event) {
          var files = event.target.files
          var file = files !== null && files !== undefined ? files[0] : undefined
          if (file === undefined) return
          setBusy(true)
          setError(null)
          setResult(null)
          Promise.resolve(file.arrayBuffer())
            .then(function (buffer) { return performImport(ctx, buffer) })
            .then(
              function (report) { setBusy(false); setResult(report) },
              function (reason) { setBusy(false); setError(messageOf(reason)) },
            )
        }

        var footer = [h(DialogButton, { key: 'close', disabled: busy, onClick: close }, t('close'))]
        if (result === null && error === null) {
          footer.unshift(h(DialogButton, {
            key: 'pick',
            variant: 'dshcd-button-danger',
            disabled: busy,
            onClick: function () { if (inputRef.current !== null) inputRef.current.click() },
          }, busy ? t('import.pending') : t('import.pick')))
        }

        return h(DialogShell, { t: t, title: t('import.title'), busy: busy, onClose: close, footer: footer },
          result === null && h('p', { className: 'dshcd-desc' }, t('import.desc')),
          busy && h('p', { className: 'dshcd-note', role: 'status' }, t('import.pending')),
          error !== null && h('p', { className: 'dshcd-error', role: 'alert' }, t('error.prefix', { message: error })),
          result !== null && h('div', null,
            h('p', { className: 'dshcd-ok' }, t('import.done')),
            h('p', { className: 'dshcd-desc' }, t('import.summary', { id: String(result.sessionId) }) + (result.reIded === true ? t('import.reIded') : '')),
            h('p', { className: 'dshcd-note' }, t('import.meta', { kind: String(result.kind), events: String(result.events), bytes: String(result.artifactBytes) })),
            result.droppedTornTail === true && h('p', { className: 'dshcd-note' }, t('import.tornTail')),
            result.restored !== undefined && (result.restored.media > 0 || result.restored.files > 0) &&
              h('p', { className: 'dshcd-note' }, t('import.restored', { media: String(result.restored.media), files: String(result.restored.files) })),
            Array.isArray(result.skipped) && result.skipped.length > 0 &&
              h('p', { className: 'dshcd-note' }, t('import.skipped', { count: String(result.skipped.length) })),
            h('p', { className: 'dshcd-note' }, t('import.refreshHint')),
          ),
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: IMPORT_ACCEPT,
            className: 'dshcd-hidden',
            onChange: onPick,
          }),
        )
      }

      /** A plain notice: used when a reveal fails, showing the path with a copy button. */
      function NoticeDialog(props) {
        var request = props.request
        var t = props.t
        var [copied, setCopied] = React.useState(false)
        var close = function () { props.store.close() }
        var copy = function () {
          var text = String(request.path)
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () { setCopied(true) }, function () { setCopied(false) })
          }
        }
        var footer = []
        if (request.path !== undefined) footer.push(h(DialogButton, { key: 'copy', onClick: copy }, copied ? t('copied') : t('copy')))
        footer.push(h(DialogButton, { key: 'close', onClick: close }, t('close')))
        return h(DialogShell, { t: t, title: t('notice.title'), busy: false, onClose: close, footer: footer },
          h('p', { className: 'dshcd-desc' }, t('error.prefix', { message: String(request.error) })),
          request.path !== undefined && h('p', { className: 'dshcd-note' }, t('notice.path')),
          request.path !== undefined && h('p', { className: 'dshcd-path' }, String(request.path)),
        )
      }

      /**
       * 兜底 hook：某个槽位万一带不来标准 hook，也绝不能让弹窗整个崩掉
       * （槽位条目抛异常会直接让这一格空白）。返回值是同一个常量引用，
       * 满足 useSyncExternalStore「快照要稳定」的要求。
       */
      var EMPTY_STATE = {}
      function emptyHook(selector) { return selector(EMPTY_STATE) }

      /**
       * 把这条对话移到另一个工作区。
       *
       * 工作区列表来自标准的 `useWorkspaces`（`shell.overlay` 会给这个 hook），
       * 当前所在的那个用它自己那条会话的 `cwd` 标出来（来自 `useSessions`）。
       */
      function MoveDialog(props) {
        var t = props.t
        var ctx = props.ctx
        var request = props.request
        var [busy, setBusy] = React.useState(false)
        var [error, setError] = React.useState(null)
        var [result, setResult] = React.useState(null)
        var useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : emptyHook
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : emptyHook
        /* 选择器本身也要防 undefined：快照还没到位时抛异常会让整个槽位条目崩掉（弹窗直接不出现） */
        var workspaces = useWorkspaces(function (snapshot) { return snapshot === null || snapshot === undefined ? undefined : snapshot.items })
        var byId = useSessions(function (state) { return state === null || state === undefined ? undefined : state.byId })
        var close = function () { if (!busy) props.store.close() }

        var summary = byId !== null && byId !== undefined ? byId[request.sessionId] : undefined
        var currentCwd = summary !== undefined && summary !== null && typeof summary.cwd === 'string' ? summary.cwd : undefined
        var normalize = function (value) {
          return typeof value === 'string' ? value.replace(/[\\/]+$/, '').toLowerCase() : ''
        }

        /*
         * 两种目标：列表里已有的工作区，或者**直接选一个目录**。
         * 第二种是必需的 —— 一开始只列已有工作区，可注册表里往往就只有一个（当前那个），
         * 于是弹窗里"没得选"。选目录走宿主自带的目录选择器，再让 workspaces.create 为它
         * 建立（或复用）一个工作区，然后才搬。
         */
        var move = function (workspaceId) {
          setBusy(true)
          setError(null)
          setResult(null)
          postJson(MOVE_URL, { sessionId: request.sessionId, workspaceId: String(workspaceId) }).then(expectOk).then(
            function (report) {
              setBusy(false)
              setResult(report)
              var sessions = ctx.get('sessions')
              if (sessions !== undefined && typeof sessions.refresh === 'function') {
                Promise.resolve(sessions.refresh()).catch(function () {})
              }
            },
            function (reason) { setBusy(false); setError(messageOf(reason)) },
          )
        }

        /** 打开宿主目录选择器 → 建立/复用工作区 → 搬到那里。 */
        var pickDirectoryAndMove = function () {
          var uiWorkspace = ctx.get('uiWorkspace')
          var workspaceService = ctx.get('workspaces')
          if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {
            setError(t('move.noPicker'))
            return
          }
          if (workspaceService === undefined || typeof workspaceService.create !== 'function') {
            setError(t('move.noCreate'))
            return
          }
          setBusy(true)
          setError(null)
          setResult(null)
          Promise.resolve(uiWorkspace.pickDirectory()).then(
            function (path) {
              if (path === null || path === undefined || path === '') {
                /* 用户取消了选择 */
                setBusy(false)
                return null
              }
              return Promise.resolve(workspaceService.create({ path: path })).then(
                function (view) {
                  var workspaceId = view !== null && view !== undefined
                    ? (view.workspaceId !== undefined ? view.workspaceId : (view.workspace !== undefined ? view.workspace.workspaceId : undefined))
                    : undefined
                  if (workspaceId === undefined) throw new Error(t('move.noWorkspace'))
                  setBusy(false)
                  return move(workspaceId)
                },
                function (reason) {
                  setBusy(false)
                  setError(messageOf(reason))
                },
              )
            },
            function (reason) {
              setBusy(false)
              setError(messageOf(reason))
            },
          )
        }

        var items = Array.isArray(workspaces) ? workspaces : []
        var title = request.displayTitle !== '' && request.displayTitle !== undefined ? request.displayTitle : request.sessionId

        var footer = [h(DialogButton, { key: 'close', disabled: busy, onClick: close }, t('close'))]
        if (result === null) {
          footer.unshift(h(DialogButton, { key: 'pick', disabled: busy, onClick: pickDirectoryAndMove }, t('move.pick')))
        }

        if (result !== null) {
          return h(DialogShell, { t: t, title: t('move.done'), busy: false, onClose: close, footer: footer },
            h('p', { className: 'dshcd-ok' }, t('move.summary', { title: title, workspace: String(result.to !== undefined && result.to.title !== undefined ? result.to.title : '') })),
            result.note !== undefined && h('p', { className: 'dshcd-note' }, t('move.already')),
            result.movedFile !== undefined && result.movedFile.to !== undefined && h('p', { className: 'dshcd-note' }, t('move.location', { path: String(result.movedFile.to) })),
          )
        }

        return h(DialogShell, { t: t, title: t('move.title'), busy: busy, onClose: close, footer: footer },
          h('p', { className: 'dshcd-desc' }, t('move.desc')),
          currentCwd !== undefined && h('p', { className: 'dshcd-note' }, t('move.currentDir', { path: currentCwd })),
          h('p', { className: 'dshcd-note' }, t('move.pickHint')),
          busy && h('p', { className: 'dshcd-note', role: 'status' }, t('move.pending')),
          error !== null && h('p', { className: 'dshcd-error', role: 'alert' }, t('error.prefix', { message: error })),
          items.length === 0 && h('p', { className: 'dshcd-note' }, t('move.empty')),
          h('ul', { className: 'dshcd-list' }, items.map(function (workspace, index) {
            var isCurrent = currentCwd !== undefined && normalize(workspace.path) === normalize(currentCwd)
            return h('li', { key: String(workspace.workspaceId) + String(index) },
              h('button', {
                type: 'button',
                className: 'dshcd-ws',
                disabled: busy || isCurrent,
                onClick: function () { move(workspace.workspaceId) },
              },
                h('span', { className: 'dshcd-ws-title' }, String(workspace.title) + (isCurrent ? '  ·  ' + t('move.current') : '')),
                h('span', { className: 'dshcd-ws-path' }, String(workspace.path)),
              ),
            )
          })),
        )
      }

      /**
       * 侧边栏底部的全局「导入对话」入口。
       * 宽栏时显示图标+文字，收成 56px 导轨时只剩图标（宿主会把 `wide` 传进来）。
       */
      function ImportFooterAction(props) {
        var t = props.t
        var label = t('menu.importConversation')
        return h('button', {
          type: 'button',
          className: 'dshcd-footer-action',
          title: label,
          'aria-label': label,
          onClick: function () { props.open() },
        },
          h('span', { className: 'dshcd-footer-icon', 'aria-hidden': true }, h(UploadIcon, null)),
          props.wide === true && h('span', null, label),
        )
      }

      /** The `shell.overlay` entry: dispatches whichever dialog is pending. */
      function DialogHost(props) {
        var request = props.useDialogRequest(function (pending) { return pending })
        if (request === null) return null
        if (request.kind === 'delete') return h(DeleteConfirmForm, { key: request.seq, request: request, store: props.store, ctx: props.ctx, t: props.t })
        if (request.kind === 'import') return h(ImportDialog, { key: request.seq, request: request, store: props.store, ctx: props.ctx, t: props.t })
        if (request.kind === 'move') return h(MoveDialog, { key: request.seq, request: request, store: props.store, ctx: props.ctx, t: props.t, useWorkspaces: props.useWorkspaces, useSessions: props.useSessions })
        return h(NoticeDialog, { key: request.seq, request: request, store: props.store, t: props.t })
      }

      /**
       * Register the dictionaries, the menu rows, the global import action and the dialog host.
       * @param ctx - the real Client root context of this bundle.
       */
      function apply(ctx) {
        var store = createStore()

        ctx.effect(insertStyles, 'conversation-delete: stylesheet')
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'conversation-delete: dictionaries')

        var exportRow = createActionRow({
          labelKey: 'menu.exportConversation',
          Icon: DownloadIcon,
          separatorBefore: true,
          run: function (props) {
            exportConversation(ctx, props.sessionId).then(
              function () {},
              function (reason) { store.open({ kind: 'notice', error: messageOf(reason) }) },
            )
          },
        })

        var revealRow = createActionRow({
          labelKey: 'menu.revealConversation',
          Icon: FolderIcon,
          run: function (props) {
            postJson(REVEAL_URL, { sessionId: props.sessionId }).then(
              function (answer) {
                if (answer.ok === true && answer.body.ok === true) return
                store.open({
                  kind: 'notice',
                  error: typeof answer.body.error === 'string' && answer.body.error !== '' ? answer.body.error : 'HTTP ' + String(answer.status),
                  path: typeof answer.body.path === 'string' ? answer.body.path : undefined,
                })
              },
              function (reason) { store.open({ kind: 'notice', error: messageOf(reason) }) },
            )
          },
        })

        var moveRow = createActionRow({
          labelKey: 'menu.moveConversation',
          Icon: MoveIcon,
          run: function (props) {
            store.open({ kind: 'move', sessionId: props.sessionId, displayTitle: props.displayTitle })
          },
        })

        var deleteRow = createActionRow({
          labelKey: 'menu.deleteConversation',
          Icon: TrashIcon,
          danger: true,
          separatorBefore: true,
          run: function (props) {
            store.open({ kind: 'delete', sessionId: props.sessionId, displayTitle: props.displayTitle })
          },
        })

        ctx.slots.inject(MENU_SLOT, function* () {
          yield ctx.slots.register({ name: MENU_SLOT, id: 'conversation-delete.export', order: 410, locale: NS }, exportRow)
          yield ctx.slots.register({ name: MENU_SLOT, id: 'conversation-delete.reveal', order: 420, locale: NS }, revealRow)
          yield ctx.slots.register({ name: MENU_SLOT, id: 'conversation-delete.move', order: 440, locale: NS }, moveRow)
          yield ctx.slots.register({ name: MENU_SLOT, id: 'conversation-delete.delete', order: 500, locale: NS }, deleteRow)
        })

        /* 「导入对话」是全局动作：放在侧边栏底部 Settings 旁边的动作区，而不是某条对话的右键菜单里 */
        ctx.slots.inject(FOOTER_SLOT, function* () {
          yield ctx.slots.register({
            name: FOOTER_SLOT,
            id: 'conversation-delete.import',
            order: 100,
            locale: NS,
            inject: function () {
              return { open: function () { store.open({ kind: 'import' }) } }
            },
          }, ImportFooterAction)
        })

        ctx.slots.inject(OVERLAY_SLOT, function* () {
          yield ctx.slots.register({
            name: OVERLAY_SLOT,
            id: 'conversation-delete.dialog',
            locale: NS,
            inject: function () {
              return {
                store: store,
                ctx: ctx,
                hooks: { dialogRequest: store.source },
              }
            },
          }, DialogHost)
        })
      }

      /*
       * The browser half is loaded on its own, so it needs its own `inject`: the
       * Host half's declaration does not apply here. `sessions`, `uiWorkspace` and
       * `sessionLogDownload` are read through the context with undefined checks,
       * so a composition without them still gets the menu rows.
       */
      exports.inject = ['slots', 'locale']
      exports.apply = apply

      return module.exports
    },
  })
}

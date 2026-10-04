/**
 * dsh-plugin-conversation-delete — Client half.
 *
 * Hand-written bundle in the same lazy-CJS form the DSH bundler emits, so a
 * standalone plugin needs no build step: executing this file only registers a
 * factory, and every side effect lives inside the factory and runs at the
 * plugin's activation.
 *
 * Two contributions, one shared request:
 *
 *   - `sidebar.workspaces.session.menu.item` — the destructive row at order 500
 *     (after the shipped pin/rename/fork/archive). It only raises the request:
 *     the row unmounts together with the menu it sits in, so it cannot own a
 *     dialog.
 *   - `shell.overlay` — the confirmation dialog, which outlives the menu.
 *
 * Confirming reuses the shipped archive action (stop the Session's running work,
 * and clear the selection when it was the open conversation), then asks the Host
 * to delete the Session's own files, then refreshes the Session catalogue so the
 * sidebar row is really gone.
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
      /** Frame-wide floating layer, above every column: where the dialog lives. */
      var OVERLAY_SLOT = 'shell.overlay'
      /** The Host route that performs the deletion. */
      var DELETE_URL = '/conversation-delete/delete'
      var STYLE_TAG_ID = 'dsh-plugin-conversation-delete/styles'

      var zh = {
        'menu.deleteConversation': '删除对话',
        'confirm.title': '删除这个对话？',
        'confirm.desc': '“{title}”将从列表中移除，且无法恢复。',
        'confirm.note': '该对话的聊天记录与其自己磁盘上的会话文件都会被删除；工作目录里的文件不受影响。',
        'confirm.action': '删除',
        'confirm.pending': '正在删除…',
        'cancel': '取消',
        'close': '关闭',
        'row.aria': '更多操作：{name}',
        'error.prefix': '删除失败：{message}'
      }

      var en = {
        'menu.deleteConversation': 'Delete conversation',
        'confirm.title': 'Delete this conversation?',
        'confirm.desc': '"{title}" will be removed from the list and cannot be recovered.',
        'confirm.note': 'The chat record and this conversation\'s own session files on disk are deleted. Files in the working directory are not affected.',
        'confirm.action': 'Delete',
        'confirm.pending': 'Deleting…',
        'cancel': 'Cancel',
        'close': 'Close',
        'row.aria': 'More actions: {name}',
        'error.prefix': 'Delete failed: {message}'
      }

      /*
       * Class names are this plugin's own: the primitives' CSS-module hashes are
       * private build output, so the row and the dialog restate the shipped
       * markup and rules under a `dshcd-` prefix. Only `--dsw-*` theme tokens are
       * referenced, so light and dark themes both apply.
       */
      var CSS = [
        '.dshcd-wrap{position:relative}',
        '.dshcd-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
        '.dshcd-wrap:first-child>.dshcd-sep:first-child{display:none}',
        '.dshcd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
        'border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;',
        'font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);text-align:left}',
        '.dshcd-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
        '.dshcd-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
        '.dshcd-item:disabled{opacity:.4;cursor:not-allowed}',
        '.dshcd-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;',
        'color:var(--dsw-alias-state-error-primary)}',
        '.dshcd-icon svg{width:14px;height:14px}',
        '.dshcd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshcd-layer{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;',
        'pointer-events:auto;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
        '.dshcd-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);',
        'backdrop-filter:var(--dsw-mask-blur)}',
        '.dshcd-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;',
        'width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);',
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
        '.dshcd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
        '.dshcd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
        'height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-family:inherit;',
        'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}',
        '.dshcd-button:disabled{cursor:not-allowed;opacity:.4}',
        '.dshcd-outline{border:.5px solid var(--dsw-alias-border-l3)}',
        '.dshcd-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshcd-danger{color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-state-error-primary)}',
        '.dshcd-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
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
       * The one pending delete request, shared by the menu row (writer) and the
       * overlay dialog (reader). `getSnapshot` keeps a stable reference between
       * writes, which is what `useSyncExternalStore` requires.
       */
      function createRequestStore() {
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
        return {
          source: source,
          open: function (request) {
            seq += 1
            value = { sessionId: request.sessionId, displayTitle: request.displayTitle, seq: seq }
            emit()
          },
          close: function () {
            value = null
            emit()
          },
        }
        function emit() {
          for (var listener of Array.from(listeners)) {
            try { listener() } catch (error) { console.error('conversation-delete: request listener failed', error) }
          }
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

      /**
       * The destructive menu row. It dismisses the menu first — its own subtree
       * is unmounted with the menu — then raises the shared request.
       * @param props - owner share (`sessionId`, `displayTitle`), the menu open
       *   state, the raised request, and the locale seat.
       */
      function DeleteConversationMenuItem(props) {
        var sessionId = props.sessionId
        var displayTitle = props.displayTitle
        var t = props.t
        var menu = props.useMenuOpenState()
        var setMenuOpen = menu[1]
        return h('div', { className: 'dshcd-wrap' },
          h('div', { className: 'dshcd-sep', role: 'separator' }),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dshcd-item',
            title: t('menu.deleteConversation'),
            onClick: function () {
              setMenuOpen(false)
              props.requestDelete({ sessionId: sessionId, displayTitle: displayTitle })
            },
          },
            h('span', { className: 'dshcd-icon', 'aria-hidden': true }, h(TrashIcon, null)),
            h('span', { className: 'dshcd-label' }, t('menu.deleteConversation')),
          ),
        )
      }

      /** Perform one deletion: stop the work, delete the files, refresh the catalogue. */
      function performDelete(ctx, sessionId) {
        var sessions = ctx.get('sessions')
        var uiWorkspace = ctx.get('uiWorkspace')
        var stopped = Promise.resolve()
        if (uiWorkspace !== undefined && typeof uiWorkspace.archiveSession === 'function') {
          /*
           * The shipped archive action is reused rather than reimplemented: it
           * asks the Host to stop the Session's running work and clears the
           * selection when this was the open conversation. A refusal here is not
           * fatal — the Host's own delete route stops the work again.
           */
          stopped = Promise.resolve(uiWorkspace.archiveSession(sessionId, { stopActivity: true })).then(
            function () {},
            function (error) {
              console.warn('conversation-delete: archive before delete failed', error)
            },
          )
        }
        return stopped
          .then(function () { return new Promise(function (done) { window.setTimeout(done, 400) }) })
          .then(function () {
            return window.fetch(DELETE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: sessionId }),
            })
          })
          .then(function (response) {
            return response.json().catch(function () { return {} }).then(function (body) {
              var report = body !== null && typeof body === 'object' ? body : {}
              if (response.ok !== true || report.ok !== true) {
                throw new Error(typeof report.error === 'string' && report.error !== '' ? report.error : 'HTTP ' + String(response.status))
              }
              return report
            })
          })
          .then(function (report) {
            if (sessions === undefined || typeof sessions.refresh !== 'function') return report
            return Promise.resolve(sessions.refresh()).then(function () { return report })
          })
      }

      /**
       * One request's dialog form. In-flight and error state die with the request
       * because the component is keyed by it.
       * @param props - the request, the shared store, the plugin context, and the locale seat.
       */
      function ConfirmForm(props) {
        var request = props.request
        var t = props.t
        var [busy, setBusy] = React.useState(false)
        var [error, setError] = React.useState(null)
        var closeRef = React.useRef(null)

        React.useEffect(function () {
          if (closeRef.current !== null) closeRef.current.focus()
        }, [])

        React.useEffect(function () {
          var onKeyDown = function (event) {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            if (!busy) props.store.close()
          }
          document.addEventListener('keydown', onKeyDown, true)
          return function () { document.removeEventListener('keydown', onKeyDown, true) }
        }, [busy, props.store])

        var close = function () {
          if (busy) return
          props.store.close()
        }

        var confirm = function () {
          setBusy(true)
          setError(null)
          performDelete(props.ctx, request.sessionId).then(
            function () {
              setBusy(false)
              props.store.close()
            },
            function (reason) {
              setBusy(false)
              setError(String(reason !== null && reason !== undefined && reason.message !== undefined ? reason.message : reason))
            },
          )
        }

        var title = request.displayTitle !== '' ? request.displayTitle : request.sessionId

        return h('div', { className: 'dshcd-layer' },
          h('div', { className: 'dshcd-mask', 'aria-hidden': true, onMouseDown: close }),
          h('div', {
            className: 'dshcd-dialog',
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'dshcd-title',
          },
            h('div', { className: 'dshcd-header' },
              h('h2', { className: 'dshcd-title', id: 'dshcd-title' }, t('confirm.title')),
              h('button', {
                type: 'button',
                ref: closeRef,
                className: 'dshcd-close',
                'aria-label': t('close'),
                disabled: busy,
                onClick: close,
              }, '✕'),
            ),
            h('p', { className: 'dshcd-desc' }, t('confirm.desc', { title: title })),
            h('p', { className: 'dshcd-note' }, t('confirm.note')),
            error !== null && h('p', { className: 'dshcd-error', role: 'alert' }, t('error.prefix', { message: error })),
            h('div', { className: 'dshcd-footer' },
              h('button', {
                type: 'button',
                className: 'dshcd-button dshcd-outline',
                disabled: busy,
                onClick: close,
              }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'dshcd-button dshcd-danger',
                disabled: busy,
                onClick: confirm,
              }, busy ? t('confirm.pending') : t('confirm.action')),
            ),
          ),
        )
      }

      /**
       * The `shell.overlay` entry: nothing while no request is pending, otherwise
       * one dialog for it.
       * @param props - the request hook, the shared store, and the locale seat.
       */
      function DeleteConversationDialog(props) {
        var ctx = props.ctx
        var store = props.store
        var request = props.useDeleteRequest(function (pending) { return pending })
        if (request === null) return null
        return h(ConfirmForm, { key: request.seq, request: request, store: store, ctx: ctx, t: props.t })
      }

      /**
       * Register the dictionaries, the destructive menu row, and the dialog.
       * @param ctx - the real Client root context of this bundle.
       */
      function apply(ctx) {
        var store = createRequestStore()

        ctx.effect(insertStyles, 'conversation-delete: stylesheet')
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'conversation-delete: dictionaries')

        var menuInjected = function () {
          return { requestDelete: function (request) { store.open(request) } }
        }

        ctx.slots.inject(MENU_SLOT, function* () {
          yield ctx.slots.register({
            name: MENU_SLOT,
            id: 'conversation-delete.delete',
            order: 500,
            locale: NS,
            inject: menuInjected,
          }, DeleteConversationMenuItem)
        })

        ctx.slots.inject(OVERLAY_SLOT, function* () {
          yield ctx.slots.register({
            name: OVERLAY_SLOT,
            id: 'conversation-delete.confirm',
            locale: NS,
            inject: function () {
              return {
                store: store,
                ctx: ctx,
                hooks: { deleteRequest: store.source },
              }
            },
          }, DeleteConversationDialog)
        })
      }

      /*
       * The browser half is loaded on its own, so it needs its own `inject`: the
       * Host half's declaration does not apply here. `sessions` and `uiWorkspace`
       * are read through the context, not injected as hard dependencies, so a
       * composition without them still gets the menu row.
       */
      exports.inject = ['slots', 'locale']
      exports.apply = apply

      return module.exports
    },
  })
}

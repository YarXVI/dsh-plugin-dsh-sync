// dsh-plugin-dsh-sync — Web client half.
// Registers a left-sidebar entry plus a main panel that talks to the host
// route /plugins/dsh-plugin-dsh-sync/panel.
//
// The layout follows the Harness Plugin Manager page: a wide page header,
// grouped panels, 28–32px controls, hairline dividers and theme tokens only.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dsh-sync',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'dsh-sync-panel'
    const ROUTE = '/plugins/dsh-plugin-dsh-sync/panel'
    const POLL_MS = 4000
    const STYLE_ID = 'dsh-sync-panel-style'

    // -----------------------------------------------------------------------
    // Device sync panel — v4 interaction preview ported onto the real panel API.
    //
    // Visual tokens mirror the native DSH settings pages: switch 36x20, buttons
    // 36 (md) / 28 (sm), radius 12 / 8, body 14/22, row title 14/22, row desc
    // 13/20, dialog title 15/22. All network calls keep using api() + the 4s
    // poll; every action is fail-soft (toast the error, keep the last state).
    // -----------------------------------------------------------------------

    const STR = {
      title: '设备同步',
      subtitle: '同一账号、同一局域网内的设备之间同步会话、工作区与设置',
      back: '返回对话',
      loading: '正在读取同步状态…',
      offline: 'Host 未返回状态，检查插件是否已加载。',
      refresh: '刷新',
      running: '运行中',
      stopped: '已停止',
      restart: '插件与设置类文件同步完成后，重启 DSH 才会完全生效。',
    }

    const PANEL_ROUTE = ROUTE
    const SHADOW_PANEL_ROUTE = '/plugins/dsh-plugin-dsh-sync/shadow'
    const PAGE_SIZE = 4
    const RETENTION_DAYS = [0, 7, 30, 45, 90]
    // The engine validates backupDays as an integer in 1..3650 (no "0 = keep
    // forever" value yet), so only offer concrete day counts here.
    const BACKUP_DAYS = [7, 30, 45, 90]
    const CONFLICT_TAG = { keep: 'dsync-tag-blue', eligible: 'dsync-tag-warn', pending: 'dsync-tag-plain' }

    // Shared with the merged shadow client (same bundle): when the backend
    // reports `settings.shadowWorkspace.enabled === false`, the shadow client
    // hides its sidebar launcher. `null` means "not reported yet" so an older
    // backend keeps the previous always-visible behaviour.
    const shadowGate = { enabled: null }

    // Where the shadow workspace page should return to. The launcher opens it
    // from the sidebar (back = conversation), while the device-sync page opens
    // it from settings (back = that settings page) — one page, two entry points.
    const shadowReturnPanel = { id: null }

    const SET_LABELS = {
      sessions: '会话记录',
      workspace: '工作区索引',
      storages: '其它设置数据',
      profile: '配置与插件',
      modules: '插件依赖',
      credentials: '模型 API 密钥',
      attachments: '附件',
      cache: '缓存',
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      const style = existing || document.createElement('style')
      if (!existing) {
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = `
.dsync-shell{box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsync-page{box-sizing:border-box;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 clamp(24px,4vw,48px) 48px;font-size:14px;line-height:22px}
.dsync-page>*{width:100%;max-width:820px}
.dsync-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px}
.dsync-heading{min-width:0;max-width:100%}
.dsync-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsync-intro{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.dsync-toolbar{white-space:nowrap;flex:none;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}
.dsync-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.dsync-pill-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-warning-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 9%,transparent)}
.dsync-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex:none}
.dsync-dot.ok{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsync-dot.warn{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dsync-dot.err{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsync-sec{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsync-sec-head{display:flex;align-items:center;gap:10px;min-height:22px;flex-wrap:wrap}
.dsync-sec-title{margin:0;font-size:14px;font-weight:500;line-height:22px;flex:none}
.dsync-sec-note{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsync-sec-extra{flex:none;margin-left:auto;display:flex;align-items:center;gap:8px}
.dsync-panel{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,20px);overflow:hidden;min-width:0}
.dsync-row{box-sizing:border-box;display:flex;align-items:center;gap:16px;min-height:52px;padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsync-row:first-child{border-top:0}
.dsync-row-click{cursor:pointer}
.dsync-row-click:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsync-row-main{flex:1;min-width:0}
.dsync-row-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:400;line-height:22px}
.dsync-row-desc{margin-top:1px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsync-row-end{flex:none;display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.dsync-row-value{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsync-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.dsync-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsync-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsync-btn:disabled{opacity:.45;cursor:not-allowed}
.dsync-btn-small{height:28px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:18px}
.dsync-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.dsync-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.dsync-btn-danger{background:transparent;border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsync-btn-danger:hover:not(:disabled){background:var(--dsync-hover-danger,rgba(242,90,90,.12));border-color:transparent}
.dsync-btn-ghost-danger{background:transparent;border-color:transparent;color:var(--dsw-alias-state-error-primary,#ef4444);padding:0 8px}
.dsync-btn-ghost-danger:hover:not(:disabled){background:var(--dsync-hover-danger,rgba(242,90,90,.12))}
.dsync-spinner{width:12px;height:12px;flex:none;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dsync-spin .7s linear infinite}
@keyframes dsync-spin{to{transform:rotate(360deg)}}
.dsync-switch{position:relative;box-sizing:border-box;width:36px;height:20px;flex:none;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.35));cursor:pointer;transition:background .12s ease}
.dsync-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsync-switch:disabled{opacity:.45;cursor:not-allowed}
.dsync-switch .dsync-knob{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-caption,#adb2b8);transition:transform .12s ease}
.dsync-switch.on{background:var(--dsw-alias-brand-primary)}
.dsync-switch.on .dsync-knob{background:var(--dsw-alias-bg-base);transform:translateX(16px)}
.dsync-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;font-weight:400}
.dsync-tag-blue{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 16%,transparent);color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsync-tag-warn{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dsync-tag-plain{background:transparent;border:.5px solid var(--dsw-alias-border-l3)}
.dsync-input{box-sizing:border-box;height:36px;min-width:0;flex:1 1 140px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsync-input::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsync-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0;border-color:transparent}
.dsync-field{display:flex;align-items:center;gap:8px;min-width:0;max-width:340px;width:100%}
.dsync-select{box-sizing:border-box;height:28px;padding:0 24px 0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsync-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0;border-color:transparent}
.dsync-num{box-sizing:border-box;width:76px;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:right}
.dsync-num:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0;border-color:transparent}
.dsync-num-wrap{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-check{width:16px;height:16px;margin:0;flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}
.dsync-check:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsync-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsync-empty{padding:14px 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsync-role-card{display:flex;align-items:flex-start;gap:14px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-bg-layer-1)}
.dsync-role-icon{width:44px;height:44px;flex:none;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsync-role-main{flex:1;min-width:0}
.dsync-role-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:500;line-height:22px}
.dsync-role-desc{margin-top:2px;max-width:640px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsync-role-meta{margin-top:8px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-role-meta>span{display:inline-flex;align-items:center;gap:6px}
.dsync-role-actions{flex:none;display:flex;gap:8px;align-items:center}
.dsync-peer{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsync-peer:first-child{border-top:0}
.dsync-peer-icon{width:40px;height:40px;flex:none;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsync-peer-main{flex:1;min-width:0}
.dsync-peer-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13.5px;font-weight:500;line-height:20px}
.dsync-peer-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-peer-meta{margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-peer-hint{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-peer-actions{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding-left:8px}
.dsync-strip{display:flex;align-items:center;gap:12px;padding:9px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.dsync-strip-warn{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 82%,var(--dsw-alias-label-primary))}
.dsync-strip-main{flex:1;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsync-set-head{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 16px 8px 10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsync-set-head:first-child{border-top:0}
.dsync-set-head.changed{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 6%,transparent)}
.dsync-set-chev{width:26px;height:26px;flex:none;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsync-set-chev:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsync-set-chev svg{transition:transform .15s ease}
.dsync-set-chev[aria-expanded="true"] svg{transform:rotate(180deg)}
.dsync-set-drawer{padding:8px 16px 12px 42px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l1)}
.dsync-drawer-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:2px 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-drawer-bar b{color:var(--dsw-alias-label-primary);font-weight:500}
.dsync-drawer-note{margin:0 0 8px;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-items{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;padding-right:2px}
.dsync-items.off{opacity:.55}
.dsync-item{display:flex;align-items:flex-start;gap:10px;padding:7px 8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer}
.dsync-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsync-item.changed{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 7%,transparent)}
.dsync-item input{margin-top:2px}
.dsync-item-main{flex:1;min-width:0}
.dsync-item-label{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsync-item-meta{margin-top:1px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsync-pending{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsync-pending-main{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsync-pending-note{color:var(--dsw-alias-label-tertiary)}
.dsync-conflict{display:flex;align-items:flex-start;gap:10px;padding:11px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsync-conflict:first-child{border-top:0}
.dsync-conflict input{margin-top:2px}
.dsync-conflict-main{flex:1;min-width:0}
.dsync-conflict-path{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsync-conflict-meta{margin-top:2px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dsync-conflict-tags{margin-top:5px;display:flex;gap:6px;flex-wrap:wrap}
.dsync-conflict-actions{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dsync-cleanup-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsync-cleanup-foot .grow{flex:1;min-width:120px;color:var(--dsw-alias-label-tertiary)}
.dsync-history{margin-top:8px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}
.dsync-history b{display:block;margin-bottom:2px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsync-logs{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsync-logs>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:12px 16px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsync-logs>summary::-webkit-details-marker{display:none}
.dsync-logs>summary .chev{margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dsync-logs[open]>summary .chev{transform:rotate(180deg)}
.dsync-log-body{margin:0;padding:0 16px 14px;max-height:220px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;line-height:1.7;white-space:pre-wrap;color:var(--dsw-alias-label-tertiary)}
.dsync-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsync-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsync-notice{color:var(--dsw-alias-label-tertiary)}
.dsync-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}
.dsync-dialog{box-sizing:border-box;width:min(560px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:14px;padding:20px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-bg-layer-2);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.dsync-dialog-head{display:flex;align-items:flex-start;gap:12px}
.dsync-dialog-icon{width:34px;height:34px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.dsync-dialog-icon.warn{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 16%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsync-dialog-icon.info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 16%,transparent);color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsync-dialog-heading{flex:1;min-width:0}
.dsync-dialog-title{margin:0;font-size:15px;font-weight:500;line-height:22px}
.dsync-dialog-desc{margin:4px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsync-dialog-close{flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsync-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsync-dialog-body{display:flex;flex-direction:column;gap:10px}
.dsync-dialog-foot{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:2px}
.dsync-risk-list{display:flex;flex-direction:column;gap:9px}
.dsync-risk{display:flex;gap:10px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dsync-risk b{display:block;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsync-risk-no{width:18px;height:18px;flex:none;margin-top:1px;border-radius:50%;display:grid;place-items:center;background:var(--dsync-hover-danger,rgba(242,90,90,.12));color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;font-weight:600}
.dsync-note-box{padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsync-warn-box{padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 45%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,12px);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 10%,transparent);font-size:12px;line-height:18px;color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 70%,var(--dsw-alias-label-primary))}
.dsync-ack{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsync-ack.checked{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,var(--dsw-alias-border-l3));background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 7%,transparent)}
.dsync-ack input{width:16px;height:16px;margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-state-error-primary,#ef4444);cursor:pointer}
.dsync-summary{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.dsync-summary>div{display:flex;flex-direction:column;gap:1px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-summary b{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsync-dir{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-choice{display:flex;align-items:flex-start;gap:10px;width:100%;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit}
.dsync-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsync-choice.selected{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent)}
.dsync-choice-main{flex:1;min-width:0}
.dsync-choice-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:500;line-height:20px}
.dsync-choice-desc{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-radio{position:relative;width:16px;height:16px;flex:none;margin-top:2px;border:1.5px solid var(--dsw-alias-border-l3);border-radius:50%}
.dsync-choice.selected .dsync-radio{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsync-choice.selected .dsync-radio::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsync-pick{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font:inherit}
.dsync-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsync-pick.selected{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent)}
.dsync-pick-icon{width:34px;height:34px;flex:none;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dsync-pick-main{flex:1;min-width:0}
.dsync-pick-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:500;line-height:20px}
.dsync-pick-meta{margin-top:1px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsync-sas{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:26px;line-height:34px;font-weight:600;letter-spacing:8px;text-align:center;padding:14px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-3)}
.dsync-sas-hint{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dsync-changes{display:flex;flex-direction:column;gap:8px}
.dsync-changes-head{display:flex;justify-content:space-between;gap:8px;padding:2px 2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-change-list{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto;padding:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.dsync-change-item{display:flex;align-items:flex-start;gap:10px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px)}
.dsync-change-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsync-change-main{flex:1;min-width:0}
.dsync-change-path{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsync-change-meta{margin-top:1px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dsync-pager{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsync-pager-actions{display:flex;gap:6px}
.dsync-toast-wrap{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:90;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:8px}
.dsync-toast{display:flex;align-items:center;gap:8px;max-width:80vw;padding:9px 16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.dsync-toast .ico{flex:none}
.dsync-toast-success .ico{color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsync-toast-danger .ico{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsync-toast-info .ico{color:var(--dsw-alias-label-tertiary)}
@keyframes dsync-fade{from{opacity:0}to{opacity:1}}
.dsync-backdrop{animation:dsync-fade .12s ease}
@media (max-width:720px){
.dsync-page{padding:0 14px 40px;gap:18px}
.dsync-head{padding-top:18px}
.dsync-role-card{flex-wrap:wrap}
.dsync-role-actions{width:100%;justify-content:flex-start}
.dsync-row{flex-wrap:wrap;gap:8px 12px}
.dsync-row-end{width:100%;justify-content:flex-start}
.dsync-peer{flex-wrap:wrap}
.dsync-peer-main{flex:1 1 100%}
.dsync-peer-actions{width:100%;justify-content:flex-start;padding-left:52px}
.dsync-set-drawer{padding-left:16px}
}
`
    }

    async function api(action, payload = {}) {
      const response = await fetch(PANEL_ROUTE, {
        method: action ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-sync': 'local' },
        body: action ? JSON.stringify({ action, ...payload }) : undefined,
      })
      const value = await response.json().catch(() => ({ ok: false, error: { message: 'invalid JSON from host' } }))
      if (!response.ok || value.ok === false) throw new Error(value?.error?.message || `HTTP ${response.status}`)
      return value
    }

    /**
     * The shadow workspace UI already ships its own local panel route. The
     * device-sync page only reads `display.enabled` + `display.groups` and flips
     * the display switch through it (never touching the shadow internals).
     */
    async function shadowApi(action, payload = {}) {
      const response = await fetch(SHADOW_PANEL_ROUTE, {
        method: action ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-shadow-client': '1' },
        body: action ? JSON.stringify({ action, ...payload }) : undefined,
      })
      const value = await response.json().catch(() => ({ ok: false, error: { message: 'invalid JSON from host' } }))
      if (!response.ok || value.ok === false) throw new Error(value?.error?.message || `HTTP ${response.status}`)
      return value
    }

    // -----------------------------------------------------------------------
    // Pure helpers (exported through __syncTesting for the unit tests).
    // -----------------------------------------------------------------------

    function asObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function bytesText(value) {
      const n = Number(value) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
    }

    function bytesOfFiles(files) {
      return (Array.isArray(files) ? files : []).reduce((sum, file) => sum + (Number(file && file.size) || 0), 0)
    }

    function timeText(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const diff = Date.now() - date.getTime()
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
      return date.toLocaleTimeString()
    }

    function dayCount(iso) {
      if (!iso) return null
      const ms = typeof iso === 'number' ? iso : Date.parse(iso)
      if (!Number.isFinite(ms)) return null
      return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000))
    }

    function clampRecycleMax(value, fallback = 100) {
      const n = Math.round(Number(value))
      if (!Number.isFinite(n)) return fallback
      return Math.max(1, Math.min(1000, n))
    }

    function isRetentionValue(value, values = RETENTION_DAYS) {
      return values.includes(Number(value))
    }

    /** Read `state.settings` with Phase-1 defaults and legacy fallbacks. */
    function readSettings(state) {
      const settings = asObject(state && state.settings)
      const rawCleanup = asObject(settings.cleanup)
      const cleanup = {
        enabled: rawCleanup.enabled !== false,
        retentionDays: isRetentionValue(rawCleanup.retentionDays) ? Number(rawCleanup.retentionDays) : 7,
        backups: rawCleanup.backups !== false,
        backupDays: isRetentionValue(rawCleanup.backupDays, BACKUP_DAYS) ? Number(rawCleanup.backupDays) : 45,
        recycle: rawCleanup.recycle !== false,
        recycleMax: clampRecycleMax(rawCleanup.recycleMax, 100),
      }
      const peers = Array.isArray(state && state.peers) ? state.peers : []
      const trusted = peers.filter((peer) => peer && peer.trusted)
      const hostPeer = trusted.filter((peer) => peer.role === 'host')[0] || null
      const role = settings.role === 'host' || settings.role === 'sub'
        ? settings.role
        : (hostPeer ? 'sub' : 'host')
      const roleLocked = typeof settings.roleLocked === 'boolean' ? settings.roleLocked : trusted.length > 0
      const rawShadow = asObject(settings.shadowWorkspace)
      return {
        role,
        roleLocked,
        realtime: settings.realtime === true,
        localOnlyExcluded: settings.localOnlyExcluded === true,
        peerRoles: asObject(settings.peerRoles),
        cleanup,
        shadowWorkspaceKnown: typeof rawShadow.enabled === 'boolean',
        shadowWorkspaceEnabled: rawShadow.enabled === true,
        immediate: state && (state.immediate === 'push' || state.immediate === 'pull')
          ? state.immediate
          : (role === 'host' ? 'push' : 'pull'),
      }
    }

    /** Old backend has no `settings.role`, so infer it from trusted peers. */
    function deriveRole(state) {
      const settings = readSettings(state)
      return { role: settings.role, roleLocked: settings.roleLocked }
    }

    function peerRoleOf(peer, localRole = 'host') {
      if (peer && (peer.role === 'host' || peer.role === 'sub')) return peer.role
      return localRole === 'host' ? 'sub' : 'host'
    }

    function fallbackItems(set, configured = false) {
      const id = String(set && set.id ? set.id : 'set')
      const label = String((set && set.label) || SET_LABELS[id] || id)
      return [{
        id: id + ':all',
        label: label + '（全部）',
        meta: `${Number(set && set.files) || 0} 个文件 · ${bytesText(set && set.bytes)} · 后端暂未提供逐项清单`,
        type: '',
        unique: false,
        // `items: null` = never configured (everything on); `items: []` =
        // explicitly nothing selected, so the placeholder starts unchecked.
        enabled: configured ? false : true,
      }]
    }

    /** Normalise a `list-items {setId}` payload into the drawer row shape. */
    function normalizeCatalog(value) {
      const source = asObject(value)
      const items = Array.isArray(source.items) ? source.items.map((entry, index) => {
        const item = asObject(entry)
        const id = String(item.id != null ? item.id : (item.rel != null ? item.rel : 'item-' + index))
        const files = Number(item.files)
        const size = Number(item.size)
        const meta = []
        if (Number.isFinite(files) && files > 0) meta.push(files + ' 个文件')
        if (Number.isFinite(size) && size > 0) meta.push(bytesText(size))
        return {
          id,
          label: String(item.label || item.rel || id),
          meta: String(item.meta || meta.join(' · ')),
          type: String(item.group || item.type || ''),
          unique: item.unique === true,
        }
      }) : []
      return {
        items,
        selected: Array.isArray(source.selected) ? source.selected.map(String) : [],
        all: source.all === true,
        count: items.length,
      }
    }

    /**
     * Merge the scope state, the local draft map and the Phase-2 `list-items`
     * catalogue. Order: local draft > state items > catalog baseline > placeholder.
     * `state.sets[].items` semantics are `null` = all, `[]` = none, `string[]` =
     * explicit item ids; `catalog.items` only supplies labels/metadata.
     */
    function normalizeSets(state, drafts, catalogs) {
      const lists = Array.isArray(state && state.sets) ? state.sets : []
      const draftSets = asObject(asObject(drafts).sets)
      const catalogMap = asObject(catalogs)
      return lists.map((raw) => {
        const id = String(raw.id)
        const catalog = asObject(catalogMap[id])
        const catalogItems = Array.isArray(catalog.items) && !catalog.error ? catalog.items : null
        const stateItems = Array.isArray(raw.items)
          ? raw.items.map((entry) => (typeof entry === 'string' ? entry : String(asObject(entry).id != null ? asObject(entry).id : ''))).filter(Boolean)
          : (raw.items === null ? null : undefined)
        const setDraft = asObject(draftSets[id])
        const itemDrafts = asObject(setDraft.items)
        const hasItemDrafts = Object.keys(itemDrafts).length > 0
        const sourceItems = catalogItems
          || (stateItems && stateItems.length
            ? stateItems.map((itemId) => ({ id: itemId, label: itemId, meta: '', type: '', unique: false }))
            : fallbackItems(raw, stateItems !== undefined))
        const baselineFor = (entry, itemId) => {
          if (stateItems === null) return true
          if (stateItems) return stateItems.includes(itemId)
          if (catalogItems) return catalog.all === true ? true : (catalog.selected || []).includes(itemId)
          return entry.enabled !== false
        }
        const items = sourceItems.map((entry, index) => {
          const item = typeof entry === 'string' ? { id: entry } : asObject(entry)
          const itemId = String(item.id != null ? item.id : (item.rel != null ? item.rel : 'item-' + index))
          const baseline = baselineFor(item, itemId)
          const draft = itemDrafts[itemId] !== undefined
            ? Boolean(itemDrafts[itemId])
            : (setDraft.all !== undefined ? Boolean(setDraft.all) : baseline)
          return {
            id: itemId,
            label: String(item.label || item.rel || itemId),
            meta: String(item.meta || ''),
            type: String(item.type || ''),
            unique: item.unique === true,
            enabled: baseline,
            draft,
            changed: draft !== baseline,
          }
        })
        const enabled = raw.enabled !== false
        const draft = setDraft.enabled !== undefined
          ? Boolean(setDraft.enabled)
          : (raw.draft !== undefined ? Boolean(raw.draft) : enabled)
        const scoped = Boolean(catalogItems) || stateItems !== undefined
        let explicitItems = false
        if (scoped) {
          if (hasItemDrafts) explicitItems = true
          else if (setDraft.all === true) explicitItems = false
          else if (setDraft.all === false) explicitItems = true
          else if (catalogItems) explicitItems = catalog.all !== true
          else explicitItems = stateItems !== null
        }
        // Switching back to "全选" must clear a previously persisted explicit
        // scope, so the engine needs `items: null` (omitting it means "unchanged").
        const clearItems = scoped && !explicitItems && stateItems !== null && stateItems !== undefined
        const selectedIds = items.filter((item) => item.draft).map((item) => item.id)
        return {
          id,
          label: String(raw.label || SET_LABELS[id] || id),
          desc: String(raw.desc || raw.detail || ''),
          files: Number(raw.files) || 0,
          bytes: Number(raw.bytes) || 0,
          enabled,
          draft,
          // `scoped` = a real item list is available, so a draft apply may send
          // per-item ids. Placeholder rows are never persisted as fake item ids.
          scoped,
          explicitItems,
          clearItems,
          selectedIds,
          catalogLoading: Boolean(catalog.loading),
          catalogError: catalog.error ? String(catalog.error) : '',
          catalogLoaded: Boolean(catalogItems),
          items,
          changed: draft !== enabled || items.some((item) => item.changed),
        }
      })
    }

    function pendingSets(list) {
      return (Array.isArray(list) ? list : []).filter((set) => set.changed)
    }

    /**
     * Payload for `set-sets`. The engine accepts entries as either plain ids or
     * `{id, enabled, items}` objects; object entries are what persists the
     * per-item scope. `items` is omitted for "all selected" (null) scopes and
     * only sent as an explicit id list otherwise. `enabled`/`items`/`setItems`
     * are kept as extra, backward-compatible fields for older hosts.
     */
    function setsPayload(list) {
      const sets = []
      const enabled = []
      const items = {}
      const setItems = []
      for (const set of Array.isArray(list) ? list : []) {
        const entry = { id: set.id, enabled: Boolean(set.draft) }
        if (set.explicitItems) entry.items = set.selectedIds
        else if (set.clearItems) entry.items = null
        sets.push(entry)
        if (set.draft) enabled.push(set.id)
        if (set.scoped) items[set.id] = set.selectedIds
        setItems.push({ id: set.id, enabled: Boolean(set.draft), items: set.items.map((item) => ({ id: item.id, enabled: Boolean(item.draft) })) })
      }
      return { sets, enabled, items, setItems }
    }

    /** 4-per-page slice for the push/pull file lists. */
    function pageOf(files, page, size = PAGE_SIZE) {
      const list = Array.isArray(files) ? files : []
      const pages = Math.max(1, Math.ceil(list.length / size))
      const current = Math.min(Math.max(Math.round(Number(page)) || 0, 0), pages - 1)
      return {
        page: current,
        pages,
        rows: list.slice(current * size, (current + 1) * size),
        count: list.length,
        bytes: bytesOfFiles(list),
      }
    }

    function conflictProducedDays(conflict) {
      const legacy = Number(conflict && conflict.createdDays)
      if (Number.isFinite(legacy)) return legacy
      const days = dayCount(conflict && (conflict.createdAt || conflict.at))
      return days == null ? 0 : days
    }

    /** Contract: `lastAccessAt ?? createdAt`; legacy rows use `lastAccess`/`createdDays`. */
    function conflictActiveDays(conflict) {
      const item = asObject(conflict)
      const raw = item.lastAccessAt != null ? item.lastAccessAt : item.lastAccess
      if (raw != null) {
        const n = Number(raw)
        if (Number.isFinite(n)) return n
        const days = dayCount(raw)
        if (days != null) return days
      }
      return conflictProducedDays(item)
    }

    function normalizeConflict(raw, index, cleanup) {
      const item = asObject(raw)
      const id = String(item.id || item.rel || 'conflict-' + index)
      const keep = item.keep === true
      const activeDays = conflictActiveDays(item)
      const producedDays = conflictProducedDays(item)
      const rawLast = item.lastAccessAt != null ? item.lastAccessAt : item.lastAccess
      const rawCreated = item.createdAt || item.at
      const lastMs = rawLast != null ? Date.parse(rawLast) : Number.NaN
      const createdMs = rawCreated != null ? Date.parse(rawCreated) : Number.NaN
      // The engine seeds `lastAccessAt = createdAt`; that still means "never
      // opened", so show the preview's "按产生时间兜底" wording.
      const sameInstant = Number.isFinite(lastMs) && Number.isFinite(createdMs) && lastMs === createdMs
      const neverAccessed = (item.lastAccessAt == null && item.lastAccess == null) || sameInstant
      const retention = Number(cleanup && cleanup.retentionDays != null ? cleanup.retentionDays : 7)
      const eligible = Boolean(cleanup && cleanup.enabled !== false) && !keep && activeDays >= retention
      let label = '未到保留期限'
      let tag = 'pending'
      if (keep) {
        label = '已保留 · 不会被自动清理'
        tag = 'keep'
      } else if (eligible) {
        label = neverAccessed
          ? `未访问 · 按产生时间 ${producedDays} 天 · 将自动删除`
          : `未访问 ${activeDays} 天 · 将自动删除`
        tag = 'eligible'
      }
      return {
        id,
        rel: String(item.rel || ''),
        set: String(item.set || ''),
        peer: String(item.peer || ''),
        size: Number(item.size) || 0,
        at: item.at || item.createdAt || null,
        keep,
        activeDays,
        producedDays,
        neverAccessed,
        eligible,
        label,
        tag,
        kind: String(item.kind || ''),
        note: String(item.note || ''),
      }
    }

    function conflictEligible(list, cleanup) {
      return (Array.isArray(list) ? list : []).filter((item) => !item.keep && item.activeDays >= Number(cleanup && cleanup.retentionDays != null ? cleanup.retentionDays : 7))
    }

    function isUnknownAction(error) {
      return /未知操作|unknown[- ]?action|not implemented|不支持/i.test(String(error && error.message ? error.message : error))
    }

    function sasText(value) {
      const digits = String(value == null ? '' : value).replace(/\s+/g, '')
      if (!digits) return ''
      return digits.length > 3 ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits
    }

    // -----------------------------------------------------------------------
    // Small presentational pieces.
    // -----------------------------------------------------------------------

    const GLYPHS = {
      sync: [['rect', { x: 2.5, y: 4, width: 8, height: 6, rx: 1.2 }], ['rect', { x: 13.5, y: 14, width: 8, height: 6, rx: 1.2 }], ['path', { d: 'M7 13v2.5A2.5 2.5 0 0 0 9.5 18H13' }], ['path', { d: 'M17 11V8.5A2.5 2.5 0 0 0 14.5 6H11' }], ['path', { d: 'm11 4 2 2-2 2' }], ['path', { d: 'm13 16-2 2 2 2' }]],
      host: [['rect', { x: 3, y: 4.5, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20.5h8M12 16.5v4' }]],
      laptop: [['rect', { x: 4, y: 4, width: 16, height: 11, rx: 1.6 }], ['path', { d: 'M2.5 19h19' }]],
      sub: [['rect', { x: 7, y: 3, width: 10, height: 18, rx: 2 }], ['path', { d: 'M10.5 18.5h3' }]],
      shadow: [['rect', { x: 3, y: 4, width: 11, height: 16, rx: 2 }], ['rect', { x: 14, y: 8, width: 7, height: 12, rx: 1.6 }]],
      plus: [['path', { d: 'M12 5v14M5 12h14' }]],
      check: [['path', { d: 'm5 12 4 4 10-10' }]],
      lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
      close: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
      warn: [['path', { d: 'M12 3 2.5 20h19L12 3Z' }], ['path', { d: 'M12 9v5' }], ['path', { d: 'M12 17h.01' }]],
      info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7h.01' }]],
      refresh: [['path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }], ['path', { d: 'M20 4v7h-7' }]],
      gear: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19' }]],
      folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' }]],
      up: [['path', { d: 'M12 19V5m0 0-6 6m6-6 6 6' }]],
      down: [['path', { d: 'M12 5v14m0 0 6-6m-6 6-6-6' }]],
      chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    }

    function Glyph({ name, size = 16, className = '' }) {
      const shapes = GLYPHS[name] || GLYPHS.info
      return h('svg', {
        className: 'ico ' + className,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, shapes.map((shape, index) => h(shape[0], { key: index, ...shape[1] })))
    }

    function Switch({ on, disabled, label, onChange }) {
      return h('button', {
        className: 'dsync-switch' + (on ? ' on' : ''),
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label || '开关',
        disabled: Boolean(disabled),
        onClick: () => { if (onChange) onChange(!on) },
      }, h('span', { className: 'dsync-knob' }))
    }

    function Row({ title, desc, end, className, onClick }) {
      return h('div', { className: 'dsync-row' + (className ? ' ' + className : ''), onClick },
        h('div', { className: 'dsync-row-main' },
          h('div', { className: 'dsync-row-title' }, title),
          desc ? h('div', { className: 'dsync-row-desc' }, desc) : null),
        h('div', { className: 'dsync-row-end' }, end))
    }

    function Group({ title, note, extra, children }) {
      return h('section', { className: 'dsync-sec' },
        h('div', { className: 'dsync-sec-head' },
          h('h2', { className: 'dsync-sec-title' }, title),
          note ? h('span', { className: 'dsync-sec-note' }, note) : null,
          extra ? h('span', { className: 'dsync-sec-extra' }, extra) : null),
        children)
    }

    function Modal({ title, desc, icon, tone, children, foot, onCancel }) {
      return h('div', {
        className: 'dsync-backdrop',
        onClick: (event) => { if (event.target === event.currentTarget && onCancel) onCancel() },
      },
        h('div', { className: 'dsync-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': String(title || '') },
          h('div', { className: 'dsync-dialog-head' },
            icon ? h('div', { className: 'dsync-dialog-icon ' + (tone || '') }, h(Glyph, { name: icon, size: 18 })) : null,
            h('div', { className: 'dsync-dialog-heading' },
              h('h2', { className: 'dsync-dialog-title' }, title),
              desc ? h('p', { className: 'dsync-dialog-desc' }, desc) : null),
            h('button', { className: 'dsync-dialog-close', type: 'button', 'aria-label': '关闭', onClick: onCancel }, h(Glyph, { name: 'close', size: 16 }))),
          children ? h('div', { className: 'dsync-dialog-body' }, children) : null,
          foot ? h('div', { className: 'dsync-dialog-foot' }, foot) : null))
    }

    function Btn({ children, primary, danger, ghostDanger, small, disabled, title, onClick, busy }) {
      const cls = 'dsync-btn'
        + (primary ? ' dsync-btn-primary' : '')
        + (danger ? ' dsync-btn-danger' : '')
        + (ghostDanger ? ' dsync-btn-ghost-danger' : '')
        + (small ? ' dsync-btn-small' : '')
      return h('button', { className: cls, type: 'button', disabled: Boolean(disabled), title: title || '', onClick },
        busy ? h('span', { className: 'dsync-spinner', 'aria-hidden': true }) : null,
        children)
    }

    function Tag({ children, kind }) {
      return h('span', { className: 'dsync-tag' + (kind ? ' dsync-tag-' + kind : '') }, children)
    }

    function ChangeList({ preview, page, onPage, direction }) {
      const view = pageOf(preview && preview.files, page)
      const rows = view.rows.map((file, index) => {
        const setLabel = file.set ? (SET_LABELS[file.set] || file.set) : ''
        return h('div', { className: 'dsync-change-item', key: (file.rel || 'row') + index },
          h('div', { className: 'dsync-change-main' },
            h('div', { className: 'dsync-change-path dsync-mono' }, String(file.rel || file.path || '')),
            h('div', { className: 'dsync-change-meta' }, setLabel ? `${setLabel} · ${bytesText(file.size)}` : bytesText(file.size))),
          setLabel ? h(Tag, { kind: 'plain' }, setLabel) : null)
      })
      return h('div', { className: 'dsync-changes' },
        h('div', { className: 'dsync-changes-head' },
          h('span', null, `本次将${direction}的文件（${view.count}）`),
          h('span', null, `${direction}前确认`)),
        h('div', { className: 'dsync-change-list' },
          rows.length ? rows : h('div', { className: 'dsync-empty' }, '没有需要传输的文件。')),
        h('div', { className: 'dsync-pager' },
          h('span', null, `第 ${view.page + 1} / ${view.pages} 页 · 共 ${view.count} 个文件 · ${bytesText(view.bytes)}`),
          h('span', { className: 'dsync-pager-actions' },
            h(Btn, { small: true, disabled: view.page === 0, onClick: () => onPage(view.page - 1) }, '上一页'),
            h(Btn, { small: true, disabled: view.page >= view.pages - 1, onClick: () => onPage(view.page + 1) }, '下一页'))))
    }

    function SyncGlyph(props) {
      const size = props && props.size ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        h('rect', { x: 2.5, y: 4, width: 8, height: 6, rx: 1.2 }),
        h('rect', { x: 13.5, y: 14, width: 8, height: 6, rx: 1.2 }),
        h('path', { d: 'M7 13v2.5A2.5 2.5 0 0 0 9.5 18H13' }),
        h('path', { d: 'M17 11V8.5A2.5 2.5 0 0 0 14.5 6H11' }),
        h('path', { d: 'm11 4 2 2-2 2' }),
        h('path', { d: 'm13 16-2 2 2 2' }))
    }

    function SyncIcon(props) {
      const size = props && props.size ? props.size : 16
      return h('span', { style: { display: 'inline-flex' }, 'data-dsh-plugin': 'dsh-plugin-dsh-sync', 'data-dsh-part': 'sidebar-icon' },
        h(SyncGlyph, { size }))
    }

    // -----------------------------------------------------------------------
    // Panel body.
    // -----------------------------------------------------------------------

    function PanelBody({ ctx }) {
      const [state, setState] = useState(null)
      const [shadow, setShadow] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [drafts, setDrafts] = useState({ sets: {} })
      const [catalogs, setCatalogs] = useState({})
      const [openSets, setOpenSets] = useState({})
      const [conflictSel, setConflictSel] = useState({})
      const [modal, setModal] = useState(null)
      const [countdown, setCountdown] = useState(0)
      const [preview, setPreview] = useState(null)
      const [page, setPage] = useState(0)
      const [draftName, setDraftName] = useState('')
      const [draftGroup, setDraftGroup] = useState('')
      const [manualAddress, setManualAddress] = useState('')
      const [cleanupLast, setCleanupLast] = useState(null)
      const alive = useRef(true)
      const toastTimer = useRef(0)

      const showToast = useCallback((message, kind = 'info') => {
        setToast({ message: String(message == null ? '' : message), kind })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => {
          if (alive.current) setToast(null)
        }, 3400)
      }, [])

      const load = useCallback(async (silent = false) => {
        try {
          const value = await api(null)
          if (!alive.current) return
          setState(value.state)
          setError('')
          if (!silent) {
            setDraftName(value.state?.device?.name || '')
            setDraftGroup(value.state?.device?.group || '')
          }
        } catch (err) {
          if (alive.current) setError(String(err?.message || err))
        }
      }, [])

      const loadShadow = useCallback(async () => {
        try {
          const value = await shadowApi(null)
          if (!alive.current) return
          setShadow(value.state || null)
        } catch {
          // The shadow half is optional in this page: hide the group on failure.
          if (alive.current) setShadow(null)
        }
      }, [])

      /**
       * Phase 2: expanding a scope drawer asks the host for the real item
       * catalogue (`list-items {setId}`). Failures keep the existing state /
       * placeholder rows as the fallback.
       */
      const loadCatalog = useCallback(async (setId) => {
        if (!setId) return
        setCatalogs((prev) => ({ ...(prev || {}), [setId]: { ...(prev && prev[setId] ? prev[setId] : {}), loading: true, error: '' } }))
        try {
          const value = await api('list-items', { setId })
          if (!alive.current) return
          const catalog = normalizeCatalog(value)
          setCatalogs((prev) => ({ ...(prev || {}), [setId]: { loading: false, error: '', ...catalog } }))
        } catch (err) {
          if (!alive.current) return
          setCatalogs((prev) => ({
            ...(prev || {}),
            [setId]: { ...(prev && prev[setId] ? prev[setId] : {}), loading: false, error: String(err?.message || err) },
          }))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(true)
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
          if (toastTimer.current) clearTimeout(toastTimer.current)
        }
      }, [load])

      const syncing = Boolean(state?.syncing)
      useEffect(() => {
        if (!syncing) return undefined
        const timer = setInterval(() => { void load(true) }, 800)
        return () => clearInterval(timer)
      }, [syncing, load])

      useEffect(() => {
        if (!modal || modal.kind !== 'rt-final' || countdown <= 0) return undefined
        const timer = setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
        return () => clearTimeout(timer)
      }, [modal, countdown])

      // Escape closes any dialog without sending a request (same cancel rule).
      useEffect(() => {
        if (!modal || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') {
            setModal(null)
            setCountdown(0)
            setPreview(null)
            showToast('已取消 · 未执行任何同步或设置变更')
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [modal, showToast])

      const settings = useMemo(() => readSettings(state), [state])

      // Mirror the backend gate into the shared object the merged shadow client
      // reads when it decides whether to render its sidebar launcher.
      useEffect(() => {
        shadowGate.enabled = settings.shadowWorkspaceKnown ? settings.shadowWorkspaceEnabled : null
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('shadow:gate', { detail: { enabled: shadowGate.enabled } }))
          }
        } catch {}
      }, [settings.shadowWorkspaceKnown, settings.shadowWorkspaceEnabled])

      // Only read the shadow panel (peer workspace groups) while the switch is on.
      useEffect(() => {
        if (!settings.shadowWorkspaceEnabled) {
          setShadow(null)
          return undefined
        }
        void loadShadow()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadShadow()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [settings.shadowWorkspaceEnabled, loadShadow])
      const setViews = useMemo(() => normalizeSets(state, drafts, catalogs), [state, drafts, catalogs])
      const pending = useMemo(() => pendingSets(setViews), [setViews])
      const conflicts = useMemo(() => {
        const list = Array.isArray(state?.conflicts) ? state.conflicts : []
        return list.map((row, index) => normalizeConflict(row, index, settings.cleanup))
      }, [state, settings.cleanup])
      const conflictStats = asObject(state?.cleanupStats)
      const conflictBytes = Number.isFinite(Number(conflictStats.conflictBytes))
        ? Number(conflictStats.conflictBytes)
        : conflicts.reduce((sum, row) => sum + row.size, 0)
      const recycleCount = Number(conflictStats.recycleCount) || 0

      const role = settings.role
      const roleLocked = settings.roleLocked
      const peers = (Array.isArray(state?.peers) ? state.peers : []).filter((peer) => peer && peer.trusted)
      const nearby = (Array.isArray(state?.peers) ? state.peers : []).filter((peer) => peer && !peer.trusted)
      const roleOfPeer = (peer) => {
        const mapped = settings.peerRoles[peer && peer.deviceId]
        if (mapped === 'host' || mapped === 'sub') return mapped
        return peerRoleOf(peer, role)
      }
      const onlineSubs = peers.filter((peer) => roleOfPeer(peer) === 'sub' && peer.online)
      const onlineHost = peers.filter((peer) => roleOfPeer(peer) === 'host' && peer.online)[0] || null
      const hostPeer = peers.filter((peer) => roleOfPeer(peer) === 'host')[0] || null
      const trusted = state?.device || {}
      const shadowWorkspaceOn = settings.shadowWorkspaceEnabled
      const shadowDisplay = asObject(shadow && shadow.display)
      const shadowGroups = Array.isArray(shadowDisplay.groups) ? shadowDisplay.groups : []

      // ---- generic action runner -------------------------------------------
      // `actions` may be a list: a fallback is only tried when the host does not
      // know the previous action (parallel backend rollout), never on real errors.
      const call = useCallback(async (key, actions, payload, options = {}) => {
        const list = Array.isArray(actions) ? actions : [actions]
        setBusy(key)
        setError('')
        let lastError = null
        try {
          for (const action of list) {
            try {
              const value = await api(action, payload || {})
              if (!alive.current) return null
              if (value && value.state) setState(value.state)
              if (options.success) options.success(value, action)
              return value
            } catch (err) {
              lastError = err
              if (isUnknownAction(err)) continue
              throw err
            }
          }
          throw lastError || new Error('未知操作')
        } catch (err) {
          if (!alive.current) return null
          const message = String(err?.message || err)
          // `ignoreUnknown`: backend still rolling out — stay silent and let the
          // caller decide (pairing keeps working without set-role).
          if (!(options.ignoreUnknown && isUnknownAction(err))) {
            setError(message)
            showToast((options.errorLabel ? options.errorLabel + '：' : '') + message, 'danger')
          }
          return null
        } finally {
          if (alive.current) setBusy('')
        }
      }, [showToast])

      const openModal = (kind, data) => {
        setPage(0)
        setCountdown(kind === 'rt-final' ? 3 : 0)
        setModal({ kind, ...(data || {}) })
      }
      const closeModal = () => {
        setModal(null)
        setCountdown(0)
        setPreview(null)
      }

      // ---- identity / connection ------------------------------------------
      const openConnect = () => {
        if (roleLocked && role === 'sub') {
          showToast('本机为子机，只能连接当前主机；切换身份需先断开全部连接', 'danger')
          return
        }
        setManualAddress('')
        openModal('discover', { peerId: null })
      }

      const disconnectAll = () => openModal('disconnect-all')
      const confirmDisconnectAll = () => {
        closeModal()
        void call('disconnect', 'disconnect-all', {}, {
          errorLabel: '断开连接失败',
          success: () => showToast('已断开全部连接 · 下次连接时重新选择主机 / 子机', 'success'),
        })
      }

      const startPair = async (peerId, pickedRole, localRole) => {
        const started = await call('pair-' + peerId, 'pair-start', { deviceId: peerId, role: pickedRole || localRole }, { errorLabel: '发起配对失败' })
        if (!started) return
        setModal({ kind: 'sas', peerId, sas: started.pair?.sas || started.sas || '', localRole: pickedRole || localRole })
      }

      const discoverNext = () => {
        if (!modal || !modal.peerId) return
        if (!roleLocked) {
          setModal({ kind: 'role', peerId: modal.peerId, role: null })
          return
        }
        setManualAddress('')
        closeModal()
        void startPair(modal.peerId, role, role)
      }

      const roleNext = async () => {
        if (!modal || !modal.peerId || !modal.role) return
        const peerId = modal.peerId
        const picked = modal.role
        await call('role', 'set-role', { role: picked }, { ignoreUnknown: true, errorLabel: '身份设置失败' })
        closeModal()
        void startPair(peerId, picked, picked)
      }

      const confirmPair = () => {
        if (!modal || !modal.peerId) return
        const peerId = modal.peerId
        const localRole = modal.localRole || role
        closeModal()
        void call('pair-confirm-' + peerId, 'pair-confirm', { deviceId: peerId, role: localRole }, {
          errorLabel: '确认配对失败',
          success: () => {
            showToast('已配对 · 本机身份已锁定', 'success')
            // pair-confirm returns only the peer; refresh so roleLocked/peers update.
            void load(true)
          },
        })
      }

      const submitManual = async () => {
        const address = String(manualAddress || '').trim()
        if (!address) return
        const value = await call('manual', 'add-manual', { address }, { errorLabel: '添加设备失败' })
        if (!value) return
        if (value.reachable) {
          setManualAddress('')
          closeModal()
          showToast('已添加，正在连接', 'success')
        } else {
          showToast('已保存，但暂时连不上，请检查 IP、端口和防火墙', 'danger')
        }
      }

      // ---- realtime gate ---------------------------------------------------
      const toggleRealtime = () => {
        if (settings.realtime) openModal('rt-off')
        else openModal('rt-risk', { ack: false })
      }
      const realtimeNext = () => {
        if (modal && modal.ack) openModal('rt-final')
      }
      const confirmRealtimeOn = () => {
        closeModal()
        void call('realtime', 'set-realtime', { enabled: true }, {
          errorLabel: '开启实时同步失败',
          success: () => showToast('实时同步已开启 · 已记住为默认开启', 'success'),
        })
      }
      const confirmRealtimeOff = () => {
        closeModal()
        void call('realtime-off', 'set-realtime', { enabled: false }, {
          errorLabel: '暂停实时同步失败',
          success: () => showToast('实时同步已关闭 · 已恢复手动同步', 'success'),
        })
      }

      // ---- manual sync (immediate / push / pull) ---------------------------
      const openImmediate = async () => {
        if (!roleLocked) {
          showToast('请先连接设备并确认本机身份', 'danger')
          return
        }
        const direction = settings.immediate
        setBusy('preview-immediate')
        try {
          const value = await api('preview-immediate')
          if (!alive.current) return
          const files = Array.isArray(value?.files) ? value.files : []
          setPreview({
            kind: value?.direction === 'pull' || value?.direction === 'push' ? value.direction : direction,
            target: value?.target || '',
            files,
            count: Number.isFinite(value?.count) ? value.count : files.length,
            bytes: Number.isFinite(value?.bytes) ? value.bytes : bytesOfFiles(files),
            fallback: false,
          })
          setPage(0)
          setModal({ kind: 'sync-now' })
        } catch (err) {
          if (!alive.current) return
          showToast('获取本次同步清单失败：' + String(err?.message || err) + '（仍可确认后执行）', 'danger')
          setPreview({ kind: direction, target: '', files: [], count: null, bytes: 0, fallback: true })
          setPage(0)
          setModal({ kind: 'sync-now' })
        } finally {
          if (alive.current) setBusy('')
        }
      }
      const confirmImmediate = () => {
        const info = preview || {}
        closeModal()
        void call('immediate', ['immediate-sync', 'sync-now', 'sync'], {}, {
          errorLabel: '立即同步失败',
          success: (value) => {
            const direction = value?.direction === 'pull' || value?.direction === 'push' ? value.direction : (info.kind || 'push')
            const count = Number.isFinite(info.count) ? info.count : null
            showToast(direction === 'pull'
              ? '已从主机拉取' + (count == null ? '' : ' ' + count + ' 个文件')
              : '已推送' + (count == null ? '' : ' ' + count + ' 个文件') + ' 到在线子机', 'success')
          },
        })
      }

      const openPush = async (peer) => {
        const peerId = peer.deviceId
        setBusy('preview-push-' + peerId)
        try {
          const value = await api('preview-push', { deviceId: peerId })
          if (!alive.current) return
          const files = Array.isArray(value?.files) ? value.files : []
          setPreview({
            kind: 'push',
            target: peer.name || String(peerId).slice(0, 8),
            files,
            count: Number.isFinite(value?.count) ? value.count : files.length,
            bytes: Number.isFinite(value?.bytes) ? value.bytes : bytesOfFiles(files),
          })
          setPage(0)
          setModal({ kind: 'push', peerId })
        } catch (err) {
          if (alive.current) showToast('获取推送清单失败：' + String(err?.message || err), 'danger')
        } finally {
          if (alive.current) setBusy('')
        }
      }
      const confirmPush = () => {
        if (!modal || !modal.peerId) return
        const peerId = modal.peerId
        closeModal()
        void call('push-' + peerId, 'push', { deviceId: peerId }, {
          errorLabel: '推送失败',
          success: (value) => {
            const result = value?.result || {}
            showToast('推送完成 · ' + (result.pushed || 0) + ' 个文件' + (result.errors?.length ? ' · 有错误' : ''), 'success')
          },
        })
      }

      const openPull = async (peer) => {
        const peerId = peer.deviceId
        const fromHost = role === 'sub'
        // Host pulling from a sub asks the host for that peer's remote manifest
        // (`preview-pull`); a sub pulling from its host reuses `preview-immediate`
        // so the direction always matches the file list.
        setBusy('preview-pull-' + peerId)
        try {
          const value = fromHost
            ? await api('preview-immediate')
            : await api('preview-pull', { deviceId: peerId })
          if (!alive.current) return
          const files = Array.isArray(value?.files) ? value.files : []
          setPreview({
            kind: 'pull',
            target: peer.name || String(peerId).slice(0, 8),
            fromHost,
            files,
            count: Number.isFinite(value?.count) ? value.count : files.length,
            bytes: Number.isFinite(value?.bytes) ? value.bytes : bytesOfFiles(files),
          })
          setPage(0)
          setModal({ kind: 'pull', peerId })
        } catch (err) {
          if (!alive.current) return
          showToast('获取文件清单失败：' + String(err?.message || err) + '（仍可确认后执行）', 'danger')
          setPreview({ kind: 'pull', target: peer.name, fromHost, files: [], count: null, bytes: 0, fallback: true })
          setPage(0)
          setModal({ kind: 'pull', peerId })
        } finally {
          if (alive.current) setBusy('')
        }
      }
      const confirmPull = () => {
        if (!modal || !modal.peerId) return
        const peerId = modal.peerId
        const fromHost = Boolean(preview && preview.fromHost)
        closeModal()
        void call('pull-' + peerId, 'force-pull', { deviceId: peerId }, {
          errorLabel: fromHost ? '拉取失败' : '覆盖本地失败',
          success: (value) => {
            const result = value?.result || {}
            showToast((fromHost ? '已从主机拉取' : '已用对端覆盖本机') + ' · ' + (result.pulled || 0) + ' 个文件', 'success')
          },
        })
      }

      const unpairPeer = (peer) => openModal('unpair', { peerId: peer.deviceId })
      const confirmUnpair = () => {
        if (!modal || !modal.peerId) return
        const peerId = modal.peerId
        const peerName = peers.filter((peer) => peer.deviceId === peerId).map((peer) => peer.name)[0] || '该设备'
        closeModal()
        void call('unpair', 'unpair', { deviceId: peerId }, {
          errorLabel: '解除配对失败',
          success: () => showToast('已解除与 ' + peerName + ' 的配对', 'success'),
        })
      }

      // ---- sync scope drafts ----------------------------------------------
      const updateDraft = (setId, patch) => {
        setDrafts((prev) => {
          const sets = { ...(prev && prev.sets ? prev.sets : {}) }
          const current = { ...(sets[setId] || {}) }
          if (patch && patch.items) current.items = { ...(current.items || {}), ...patch.items }
          if (patch && patch.enabled !== undefined) current.enabled = patch.enabled
          if (patch && patch.all !== undefined) current.all = patch.all
          sets[setId] = current
          return { ...(prev || {}), sets }
        })
      }
      const toggleSetDraft = (set, checked) => updateDraft(set.id, { enabled: checked })
      const toggleItemDraft = (set, item, checked) => updateDraft(set.id, { items: { [item.id]: checked } })
      const toggleAllItems = (set, checked) => updateDraft(set.id, { all: checked, items: {} })
      const toggleDrawer = (setId) => {
        setOpenSets((prev) => {
          const next = { ...(prev || {}) }
          if (next[setId]) delete next[setId]
          else next[setId] = true
          return next
        })
        // `list-items` runs on every expansion so the catalogue and the
        // persisted `selected/all` baseline stay fresh; drafts still win.
        if (!(openSets || {})[setId]) void loadCatalog(setId)
      }
      const applySets = () => {
        if (!pending.length) return
        const payload = setsPayload(setViews)
        const count = pending.length
        void call('sets', 'set-sets', payload, {
          errorLabel: '应用范围失败',
          success: () => {
            setDrafts({ sets: {} })
            showToast('同步范围已保存（' + count + ' 项变更）· 不会触发同步', 'success')
            // Persisted scope is the new baseline: refresh open catalogues so
            // the drawer reflects the saved selection (not the stale pre-save one).
            for (const setId of Object.keys(openSets || {})) {
              if (openSets[setId]) void loadCatalog(setId)
            }
          },
        })
      }
      const discardSets = () => {
        setDrafts({ sets: {} })
        showToast('已撤销范围改动 · 未触发同步', 'success')
      }
      const toggleLocalOnly = () => {
        const next = !settings.localOnlyExcluded
        void call('local-only', 'set-local-only', { enabled: next }, {
          errorLabel: '设置失败',
          success: () => showToast(next ? '已开启 · 本机独有内容不会推送' : '已关闭 · 本机独有内容会随同步推送', 'success'),
        })
      }

      // ---- cleanup / conflicts -------------------------------------------
      const patchCleanup = (patch, label) => {
        void call('cleanup', 'set-cleanup', { patch }, {
          errorLabel: label + '失败',
          success: () => showToast(label + '已更新 · 不会触发同步', 'success'),
        })
      }
      const commitRecycleMax = (event) => {
        const raw = Number(event?.target?.value)
        const max = clampRecycleMax(raw, settings.cleanup.recycleMax)
        if (Number.isFinite(raw) && raw > 1000) showToast('回收站上限最多 1000 个，已按 1000 处理', 'danger')
        patchCleanup({ recycleMax: max }, '回收站上限')
      }
      const toggleConflictSel = (id, checked) => {
        setConflictSel((prev) => ({ ...(prev || {}), [id]: checked }))
      }
      const selectedConflictIds = () => Object.keys(conflictSel || {}).filter((id) => conflictSel[id])
      const keepConflict = (item) => {
        void call('conflict-keep', 'conflict-keep', { ids: [item.id], keep: !item.keep }, {
          errorLabel: '保留操作失败',
          success: () => showToast(item.keep ? '已取消保留 · 将按保留时长自动清理' : '已保留 · 自动清理会跳过该副本', 'success'),
        })
      }
      const keepSelected = () => {
        const ids = selectedConflictIds()
        if (!ids.length) return
        void call('conflict-keep', 'conflict-keep', { ids, keep: true }, {
          errorLabel: '保留操作失败',
          success: () => showToast('已保留 ' + ids.length + ' 个副本 · 自动清理会跳过', 'success'),
        })
      }
      const openConflictDelete = (ids) => {
        if (!ids.length) return
        openModal('conflict-delete', { ids })
      }
      const confirmConflictDelete = () => {
        const ids = (modal && modal.ids) || []
        closeModal()
        void call('conflict-delete', 'conflict-delete', { ids }, {
          errorLabel: '删除冲突副本失败',
          success: (value) => {
            setConflictSel({})
            const removed = Number(value?.removed) || 0
            const freed = Number(value?.freed) || 0
            const skipped = Number(value?.skipped) || 0
            const parts = ['已删除 ' + removed + ' 个冲突副本']
            if (freed > 0) parts.push('释放 ' + bytesText(freed))
            if (skipped > 0) parts.push('部分副本不在受管目录，已保留（' + skipped + ' 个）')
            else if (settings.cleanup.recycle) parts.push('已移入回收站，7 天内可恢复')
            showToast(parts.join(' · '), skipped ? 'danger' : 'success')
          },
        })
      }
      const openCleanupRun = () => openModal('cleanup-run')
      const confirmCleanupRun = () => {
        closeModal()
        void call('cleanup-run', 'cleanup-now', {}, {
          errorLabel: '清理失败',
          success: (value) => {
            const removed = Number(value?.removed) || 0
            const freed = Number(value?.freed) || 0
            const skipped = Number(value?.skipped) || 0
            setCleanupLast({ removed, freed, skipped, at: Date.now() })
            const parts = ['已清理 ' + removed + ' 个副本', '释放 ' + bytesText(freed)]
            if (skipped > 0) parts.push('部分副本不在受管目录，已保留（' + skipped + ' 个）')
            showToast(parts.join(' · '), skipped ? 'danger' : 'success')
          },
        })
      }

      // ---- shadow workspace switch ---------------------------------------
      // Backend gate: `settings.shadowWorkspace.enabled` + `set-shadow`.
      // The shadow client itself is untouched; it only reads shadowGate.
      const toggleShadow = () => {
        const next = !shadowWorkspaceOn
        void call('shadow', 'set-shadow', { enabled: next }, {
          errorLabel: '影子工作区设置失败',
          success: () => {
            shadowGate.enabled = next
            showToast(next ? '影子工作区已开启 · 侧栏入口与分组已显示' : '影子工作区已关闭 · 入口与视图已隐藏', 'success')
          },
        })
      }
      const openShadow = () => {
        // Opened from the device-sync settings page: the shadow page's back
        // button must return to this page, not to the conversation.
        shadowReturnPanel.id = 'dsh-sync-panel'
        try { ctx?.layout?.selectPanel?.('shadow-workspace') } catch {}
      }

      // ---- device name / group -------------------------------------------
      const saveName = () => {
        const name = String(draftName || '').trim()
        if (!name) { showToast('设备名称不能为空', 'danger'); return }
        void call('name', 'rename', { name }, { errorLabel: '保存设备名称失败', success: () => showToast('设备名称已保存', 'success') })
      }
      const saveGroup = () => {
        void call('group', 'set-group', { group: String(draftGroup || '').trim() }, { errorLabel: '保存同步组失败', success: () => showToast('同步组已保存', 'success') })
      }

      // ---- render ----------------------------------------------------------
      if (!state && !error) return h('div', { className: 'dsync-shell' }, h('div', { className: 'dsync-page' }, h('div', { className: 'dsync-empty' }, STR.loading)))
      if (!state) {
        return h('div', { className: 'dsync-shell' }, h('div', { className: 'dsync-page' },
          h('button', { className: 'dsync-btn', type: 'button', onClick: () => { try { ctx?.layout?.selectPanel?.(null) } catch {} } }, '← ' + STR.back),
          h('div', { className: 'dsync-error' }, error || STR.offline)))
      }

      const last = state.lastCycle
      const progress = state.progress || null
      const retryBusy = Boolean(busy)
      const onlineSubsText = onlineSubs.length + ' 台在线子机'
      const enabledSetCount = setViews.filter((set) => set.draft).length
      const enabledFiles = setViews.filter((set) => set.draft).reduce((sum, set) => sum + set.files, 0)
      const selectedIds = selectedConflictIds()
      const eligibleConflicts = conflictEligible(conflicts, settings.cleanup)
      const eligibleBytes = eligibleConflicts.reduce((sum, row) => sum + row.size, 0)
      const pushTargets = role === 'host' ? onlineSubs.length : (onlineHost ? 1 : 0)
      const syncBlocked = !roleLocked || pushTargets === 0

      const roleIcon = role === 'host' ? 'host' : 'sub'
      const roleTitle = role === 'host' ? '主机' : '子机'
      const lockedDesc = role === 'host'
        ? '本机作为主机，可向多台子机推送；子机仅被动接收，不会反向推送。'
        : '本机作为子机，仅被动接收主机「' + (hostPeer?.name || '—') + '」的同步，推送关闭。'
      const unlockedDesc = '当前没有同步连接。下次连接设备时重新选择本机身份（主机 / 子机），选择后固定不变。已同步的数据会保留，不会回滚，也不会自动重连。'

      const identity = h('div', { className: 'dsync-role-card' },
        h('div', { className: 'dsync-role-icon' }, h(Glyph, { name: roleIcon, size: 22 })),
        h('div', { className: 'dsync-role-main' },
          h('div', { className: 'dsync-role-title' },
            '本机身份 ',
            h(Tag, { kind: role === 'host' ? 'blue' : 'plain' }, roleTitle),
            h(Tag, { kind: roleLocked ? 'plain' : 'warn' }, roleLocked ? '已锁定' : '未锁定')),
          h('div', { className: 'dsync-role-desc' }, roleLocked ? lockedDesc : unlockedDesc),
          h('div', { className: 'dsync-role-meta' },
            !roleLocked
              ? h('span', null, h('span', { className: 'dsync-dot' }), '未建立连接')
              : (role === 'host'
                ? [h('span', { key: 'a' }, h('span', { className: 'dsync-dot ok' }), onlineSubsText), h('span', { key: 'b' }, h('span', { className: 'dsync-dot ok' }), '推送可用')]
                : [h('span', { key: 'a' }, h('span', { className: 'dsync-dot warn' }), '推送已关闭'), h('span', { key: 'b' }, h('span', { className: 'dsync-dot ok' }), '仅接收主机同步')]))),
        h('div', { className: 'dsync-role-actions' },
          (peers.length > 0 || roleLocked)
            ? h(Btn, { small: true, onClick: disconnectAll }, '断开全部连接')
            : h(Btn, { small: true, primary: true, onClick: openConnect }, '连接设备')))

      const localSection = h(Group, { title: '本机' },
        h('div', { className: 'dsync-panel' },
          h(Row, {
            title: '设备名称',
            end: h('div', { className: 'dsync-field' },
              h('input', {
                className: 'dsync-input',
                value: draftName,
                maxLength: 64,
                placeholder: '设备名称',
                'aria-label': '设备名称',
                onChange: (event) => setDraftName(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') saveName() },
              }),
              h(Btn, { small: true, disabled: retryBusy || !String(draftName || '').trim() || draftName === trusted.name, onClick: saveName }, '保存')),
          }),
          h(Row, {
            title: '设备身份',
            desc: '建立第一个连接时确认本机身份，选中后固定不变；切换主机 / 子机需先断开全部连接。',
            end: h('span', { className: 'dsync-row-value' },
              h(Tag, { kind: role === 'host' ? 'blue' : 'plain' }, roleTitle),
              h(Tag, { kind: roleLocked ? 'plain' : 'warn' }, roleLocked ? '已锁定' : '未锁定')),
          }),
          h(Row, {
            title: '同步组',
            desc: trusted.groupSource === 'account' ? '同账号自动生成；两台电脑填同一个组名也可配对。' : '两台电脑填同一个组名也可配对。',
            end: h('div', { className: 'dsync-field' },
              h('input', {
                className: 'dsync-input',
                value: draftGroup,
                maxLength: 96,
                placeholder: '同步组',
                'aria-label': '同步组',
                onChange: (event) => setDraftGroup(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') saveGroup() },
              }),
              h(Btn, { small: true, disabled: retryBusy || draftGroup === trusted.group, onClick: saveGroup }, '保存')),
          }),
          h(Row, { title: '设备 ID', end: h('span', { className: 'dsync-mono' }, String(trusted.deviceId || '').slice(0, 18) + '…') }),
          h(Row, {
            title: '监听端口',
            desc: syncing && progress
              ? `同步中 · 已拉取 ${progress.files || 0} 个文件 · ${bytesText(progress.bytes || 0)}`
              : (last ? `最近同步 ${timeText(last.at)} · 拉取 ${last.pulled || 0} · 合并 ${last.merged || 0} · 删除 ${last.deleted || 0}` : null),
            end: h('span', { className: 'dsync-mono' }, String(state.port || '—')),
          }),
          h(Row, {
            title: '本机地址',
            desc: (state.addresses || []).length ? '在另一台电脑上手动添加时，填这里的 IP + 监听端口。' : null,
            end: h('span', { className: 'dsync-mono' }, (state.addresses || []).join(', ') || '—'),
          })))

      const realtimeTargets = role === 'host' ? onlineSubsText : '1 台主机（只接收）'
      const realtimeOnDesc = '已开启（已记住设置）。' + (role === 'host'
        ? '本机改动会自动同步到 ' + realtimeTargets + '；'
        : '会实时接收主机改动，推送保持关闭；') + '关闭需在弹窗中确认。'
      const realtimeOffDesc = role === 'host'
        ? '默认关闭。开启前需要阅读注意事项并连续两次手动确认；开启后自动推送与接收。'
        : '默认关闭。开启前需要阅读注意事项并连续两次手动确认；开启后只实时接收主机改动，推送保持关闭。'
      const realtimeStrip = settings.realtime ? h('div', { className: 'dsync-strip dsync-strip-warn' },
        h('span', { className: 'dsync-strip-main' },
          h('span', { className: 'dsync-dot warn' }),
          role === 'host'
            ? `实时同步运行中 · 自动推送与接收已开启 · 覆盖 ${enabledSetCount} 个同步范围`
            : '实时同步运行中 · 正在实时接收主机改动 · 推送保持关闭'),
        h(Btn, { small: true, ghostDanger: true, onClick: () => openModal('rt-off') }, '暂停实时同步')) : null

      const syncSection = h(Group, {
        title: '同步模式',
        note: settings.realtime
          ? '实时同步运行中；范围变更只改设置，下一次文件变动时按新范围同步。'
          : '实时同步默认关闭；同步只由「立即同步 / 推送 / 覆盖本地」显式触发。',
      },
        h('div', { className: 'dsync-panel' },
          realtimeStrip,
          h(Row, {
            title: ['实时同步', settings.realtime ? h(Tag, { key: 'rt', kind: 'warn' }, '运行中') : null],
            desc: settings.realtime ? realtimeOnDesc : realtimeOffDesc,
            end: h(Switch, { on: settings.realtime, disabled: retryBusy, label: '实时同步', onChange: toggleRealtime }),
          }),
          h(Row, {
            title: '同步执行',
            desc: settings.realtime
              ? '实时同步已开启，' + (role === 'host' ? '文件变化会自动推送；' : '主机的文件变化会自动同步到本机；') + '「立即同步 / 推送 / 覆盖本地」仍可手动执行。'
              : `所有数据同步只在点击「立即同步」「推送」或「覆盖本地」时执行；启动、发现设备、配对、勾选范围都不会自动同步。最近同步：${last ? timeText(last.at) : '—'}。`,
            end: h('span', { className: 'dsync-row-value' },
              h('span', { className: 'dsync-dot ' + (settings.realtime ? 'ok' : '') }),
              settings.realtime ? '自动 + 手动' : '仅手动触发'),
          }),
          h(Row, {
            title: '立即同步',
            desc: role === 'host'
              ? '把本机变更推送到全部在线子机；推送前弹窗列出具体文件，确认后才执行。'
              : '从主机拉取最新变更；拉取前弹窗列出具体文件，确认后才执行。',
            end: h(Btn, {
              small: true,
              primary: true,
              disabled: retryBusy || syncBlocked,
              title: !roleLocked ? '请先连接设备并确认本机身份' : (pushTargets === 0 ? '暂无可用的在线设备' : ''),
              busy: busy === 'preview-immediate',
              onClick: openImmediate,
            }, '立即同步'),
          })))

      const peerCard = (peer) => {
        const peerRole = roleOfPeer(peer)
        const offline = !peer.online
        const canPush = role === 'host' && roleLocked && peerRole === 'sub' && !offline
        const pushTitle = offline ? '设备离线，恢复在线后才能操作'
          : role === 'sub' ? '本机为子机，推送已关闭；只有主机能发起推送'
            : '把本机文件推送到该设备'
        const pullTitle = offline ? '设备离线，恢复在线后才能操作'
          : role === 'sub' ? '从主机拉取并覆盖本机文件' : '用对端版本覆盖本机文件'
        const hint = peerRole === 'host'
          ? '主机 · 本机作为子机，仅接收它的同步，推送关闭'
          : '子机 · 仅被动接收本机推送，不会反向同步'
        const actions = role === 'host'
          ? [
            h(Btn, { key: 'push', small: true, primary: canPush, disabled: retryBusy || !canPush, title: pushTitle, busy: busy === 'preview-push-' + peer.deviceId, onClick: () => openPush(peer) }, '推送'),
            h(Btn, { key: 'pull', small: true, disabled: retryBusy || offline, title: pullTitle, onClick: () => openPull(peer) }, '覆盖本地'),
            h(Btn, { key: 'unpair', small: true, ghostDanger: true, disabled: retryBusy, onClick: () => unpairPeer(peer) }, '解除配对'),
          ]
          : [
            h(Btn, { key: 'pull', small: true, primary: true, disabled: retryBusy || offline, title: pullTitle, busy: busy === 'preview-pull-' + peer.deviceId, onClick: () => openPull(peer) }, '从主机拉取'),
            h(Btn, { key: 'unpair', small: true, ghostDanger: true, disabled: retryBusy, onClick: () => unpairPeer(peer) }, '解除配对'),
          ]
        return h('div', { className: 'dsync-peer', key: peer.deviceId },
          h('div', { className: 'dsync-peer-icon' }, h(Glyph, { name: peerRole === 'host' ? 'host' : 'laptop', size: 20 })),
          h('div', { className: 'dsync-peer-main' },
            h('div', { className: 'dsync-peer-name' },
              peer.name || String(peer.deviceId).slice(0, 8),
              h(Tag, { kind: peerRole === 'host' ? 'blue' : 'plain' }, peerRole === 'host' ? '主机' : '子机'),
              peer.sameAccount ? h(Tag, { kind: 'plain' }, '同账号') : null,
              h('span', { className: 'dsync-peer-state' },
                h('span', { className: 'dsync-dot ' + (offline ? '' : 'ok') }),
                offline ? '离线' : '在线')),
            h('div', { className: 'dsync-peer-meta' },
              h('span', { className: 'dsync-mono' }, peer.host ? `${peer.host}:${peer.port}` : '—'),
              h('span', null, '·'),
              h('span', { className: 'dsync-mono' }, String(peer.deviceId || '').slice(0, 12) + '…'),
              h('span', null, '·'),
              h('span', null, '最近同步 ' + (peer.lastSyncAt ? timeText(peer.lastSyncAt) : '—')),
              peer.error ? h('span', { className: 'dsync-error' }, ' · ' + peer.error) : null),
            h('div', { className: 'dsync-peer-hint' }, hint)),
          h('div', { className: 'dsync-peer-actions' }, actions))
      }

      const peersNote = !roleLocked
        ? '尚未建立同步关系。连接第一台设备时确认本机身份（主机 / 子机），选择后固定不变。'
        : (role === 'host' ? '本机为主机，连接的其他设备默认为子机；一台主机可同步多台子机。' : '本机为子机，只能连接这一台主机；无法再连接其他子机。')
      const connectExtra = (role === 'host' && roleLocked)
        ? h(Btn, { small: true, primary: true, disabled: retryBusy, onClick: openConnect }, '连接新设备')
        : null
      const peersSection = h(Group, {
        title: '已连接设备' + (peers.length ? `（${peers.length} 台）` : ''),
        note: peersNote,
        extra: connectExtra,
      },
        h('div', { className: 'dsync-panel' },
          peers.length
            ? peers.map(peerCard)
            : h('div', { className: 'dsync-empty' }, '暂未连接设备。点击右上角「连接新设备」，第一台设备会先确认本机身份。')))

      // ---- sync scope ------------------------------------------------------
      const localOnlyRow = h(Row, {
        title: '本机独有内容不同步',
        desc: settings.localOnlyExcluded
          ? '已开启：自动同步时，对端没有且未手动勾选的条目视为独有内容，不会推送（仍可接收对端新增）。'
          : '关闭时：本机新增的会话 / 文件也会推到对端。开启后自动同步只推送两端都存在的条目，避免把本机独有的东西带到其他设备。',
        end: [
          settings.localOnlyExcluded ? h(Tag, { key: 'tag', kind: 'blue' }, '已排除独有内容') : null,
          h(Switch, { key: 'sw', on: settings.localOnlyExcluded, disabled: retryBusy, label: '本机独有内容不同步', onChange: toggleLocalOnly }),
        ],
      })

      const setHeads = setViews.map((set) => {
        const open = Boolean(openSets[set.id])
        const selectedCount = set.draft ? set.items.filter((item) => item.draft).length : 0
        const loadingFirst = set.catalogLoading && !set.catalogLoaded
        const head = h('div', { className: 'dsync-set-head' + (set.changed ? ' changed' : ''), key: set.id },
          h('button', {
            className: 'dsync-set-chev',
            type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': '展开' + set.label,
            onClick: () => toggleDrawer(set.id),
          }, h(Glyph, { name: 'chevron', size: 15 })),
          h('div', { className: 'dsync-row-main dsync-row-click', onClick: () => toggleDrawer(set.id) },
            h('div', { className: 'dsync-row-title' },
              set.label,
              set.changed ? h(Tag, { key: 'pending', kind: 'warn' }, '待应用') : null),
            h('div', { className: 'dsync-row-desc' },
              (set.desc ? set.desc + ' · ' : '')
              + (loadingFirst ? '正在读取逐项清单…' : `已选 ${selectedCount}/${set.items.length} 项`)
              + ` · ${set.files} 个文件 · ${bytesText(set.bytes)}`)),
          h('div', { className: 'dsync-row-end' },
            h(Btn, { small: true, onClick: () => toggleDrawer(set.id) }, open ? '收起' : '展开'),
            h('input', {
              className: 'dsync-check',
              type: 'checkbox',
              checked: Boolean(set.draft),
              disabled: retryBusy,
              'aria-label': '同步' + set.label,
              onChange: (event) => toggleSetDraft(set, event.target.checked),
            })))
        if (!open) return head
        const itemRows = set.items.map((item) => {
          return h('label', { className: 'dsync-item' + (item.changed ? ' changed' : ''), key: item.id },
            h('input', {
              className: 'dsync-check',
              type: 'checkbox',
              checked: Boolean(item.draft),
              disabled: retryBusy || !set.draft,
              'aria-label': item.label,
              onChange: (event) => toggleItemDraft(set, item, event.target.checked),
            }),
            h('div', { className: 'dsync-item-main' },
              h('div', { className: 'dsync-item-label' },
                item.label,
                item.type ? h(Tag, { key: 'type', kind: 'plain' }, item.type) : null),
              item.meta ? h('div', { className: 'dsync-item-meta' }, item.meta) : null),
            item.changed ? h(Tag, { key: 'pending', kind: 'warn' }, '待应用') : null)
        })
        const drawer = h('div', { className: 'dsync-set-drawer', key: set.id + ':drawer' },
          h('div', { className: 'dsync-drawer-bar' },
            h('span', null, '已选 ', h('b', null, String(selectedCount)), ' / ' + set.items.length + ' 项 · 共 ' + set.files + ' 个文件 · ' + bytesText(set.bytes)),
            h('span', { className: 'dsync-drawer-actions' },
              h(Btn, { small: true, disabled: retryBusy || loadingFirst, onClick: () => toggleAllItems(set, true) }, '全选'),
              h(Btn, { small: true, disabled: retryBusy || loadingFirst, onClick: () => toggleAllItems(set, false) }, '全不选'))),
          settings.localOnlyExcluded
            ? h('div', { className: 'dsync-drawer-note' }, '已开启「本机独有内容不同步」：对端没有、且未手动勾选的条目视为独有内容，不会自动推送；手动勾选可强制同步。')
            : null,
          set.draft ? null : h('div', { className: 'dsync-drawer-note' }, '先勾选上方的「' + set.label + '」总开关，才能细选下面的内容。'),
          loadingFirst
            ? h('div', { className: 'dsync-empty' }, h('span', { className: 'dsync-spinner', 'aria-hidden': true }), ' 正在读取逐项清单…')
            : null,
          set.catalogError
            ? h('div', { className: 'dsync-drawer-note' }, '逐项清单读取失败，已回退为集合级占位：' + set.catalogError)
            : null,
          (!loadingFirst && set.catalogLoaded && !set.items.length)
            ? h('div', { className: 'dsync-empty' }, '该范围暂时没有可选的条目。')
            : null,
          loadingFirst ? null : h('div', { className: 'dsync-items' + (set.draft ? '' : ' off') }, itemRows))
        return [head, drawer]
      })

      const pendingBar = h('div', { className: 'dsync-pending' },
        h(Glyph, { name: 'info', size: 15 }),
        h('span', { className: 'dsync-pending-main' },
          pending.length
            ? ['已修改 ' + pending.length + ' 项同步范围。', h('span', { key: 'note', className: 'dsync-pending-note' },
              settings.realtime
                ? '只保存设置，不会立即触发同步；实时同步已开启，将在下一次文件变动时按新范围同步。'
                : '只保存设置，不会触发同步；只有「立即同步 / 推送 / 覆盖本地」会执行同步。')]
            : h('span', { className: 'dsync-pending-note' }, '展开任一项可逐个勾选要同步的会话 / 插件 / 设置 / 依赖 / 密钥 / 附件 / 缓存；选择不会触发同步。')),
        h(Btn, { small: true, disabled: retryBusy || !pending.length, onClick: discardSets }, '撤销'),
        h(Btn, { small: true, primary: true, disabled: retryBusy || !pending.length, onClick: applySets }, '应用范围'))

      const setsSection = h(Group, {
        title: '同步范围',
        note: (role === 'host' ? '每项可展开逐条勾选；选择只改设置，不触发同步。' : '子机的范围只决定接收哪些集合；推送由主机发起。')
          + (settings.localOnlyExcluded ? ' · 已排除本机独有内容' : ''),
      },
        h('div', { className: 'dsync-panel' },
          localOnlyRow,
          setHeads,
          pendingBar))

      // ---- cleanup ---------------------------------------------------------
      const retentionOptions = (values) => values.map((days) => h('option', { key: days, value: days }, days === 0 ? '永久保留' : days + ' 天'))
      const recycleHint = settings.cleanup.recycle ? '已开启 · 7 天内可恢复' : '已关闭 · 删除后不可恢复'
      const cleanupSection = h(Group, {
        title: '清理与保留',
        note: `冲突副本默认保留 ${settings.cleanup.retentionDays === 0 ? '永久' : settings.cleanup.retentionDays + ' 天'}；按最后一次访问计时，从未访问的按冲突产生时间兜底。`,
      },
        h('div', { className: 'dsync-panel' },
          h(Row, {
            title: '自动清理',
            desc: '按保留时长自动删除没有被「保留」的冲突副本，释放磁盘空间。',
            end: h(Switch, { on: settings.cleanup.enabled, disabled: retryBusy, label: '自动清理', onChange: (next) => patchCleanup({ enabled: next }, '自动清理') }),
          }),
          h(Row, {
            title: '冲突副本保留时长',
            desc: '从最后一次访问算起；从未访问过的按冲突产生时间兜底。超过时长且未「保留」的副本自动删除。',
            end: h('select', {
              className: 'dsync-select',
              value: String(settings.cleanup.retentionDays),
              disabled: retryBusy || !settings.cleanup.enabled,
              'aria-label': '冲突副本保留时长',
              onChange: (event) => patchCleanup({ retentionDays: Number(event.target.value) }, '冲突副本保留时长'),
            }, retentionOptions(RETENTION_DAYS)),
          }),
          h(Row, {
            title: '同步备份 .bak-sync-*',
            desc: '覆盖前自动保留的备份文件，也可按天数自动清理。',
            end: [
              h(Switch, { key: 'sw', on: settings.cleanup.backups, disabled: retryBusy, label: '清理同步备份', onChange: (next) => patchCleanup({ backups: next }, '同步备份清理') }),
              h('select', {
                key: 'sel',
                className: 'dsync-select',
                value: String(settings.cleanup.backupDays),
                disabled: retryBusy || !settings.cleanup.backups,
                'aria-label': '备份保留时长',
                onChange: (event) => patchCleanup({ backupDays: Number(event.target.value) }, '备份保留时长'),
              }, retentionOptions(BACKUP_DAYS)),
            ],
          }),
          h(Row, {
            title: '删除前移入回收站',
            desc: '手动或自动删除的副本先进入回收站，7 天内可以恢复。',
            end: h(Switch, { on: settings.cleanup.recycle, disabled: retryBusy, label: '移入回收站', onChange: (next) => patchCleanup({ recycle: next }, '移入回收站') }),
          }),
          h(Row, {
            title: '回收站上限',
            desc: `最多保留 ${settings.cleanup.recycleMax} 个副本（当前 ${recycleCount} 个）；超出后按删除时间从早到晚自动清理，最多可设 1000。`,
            end: h('span', { className: 'dsync-num-wrap' },
              h('input', {
                className: 'dsync-num',
                type: 'number',
                min: 1,
                max: 1000,
                step: 10,
                key: 'recycle-max-' + settings.cleanup.recycleMax,
                defaultValue: settings.cleanup.recycleMax,
                'aria-label': '回收站上限',
                onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur() } },
                onBlur: commitRecycleMax,
              }),
              '个'),
          }),
          h(Row, {
            title: '立即清理',
            desc: (cleanupLast
              ? `上次清理 ${cleanupLast.removed} 个副本 · 释放 ${bytesText(cleanupLast.freed)}`
                + (cleanupLast.skipped ? ` · 部分副本不在受管目录，已保留（${cleanupLast.skipped} 个）` : '')
              : `上次运行 ${conflictStats.lastRun || '—'} · 待清理 ${eligibleConflicts.length} 个`)
              + ` · 当前冲突副本 ${conflicts.length} 个 / ${bytesText(conflictBytes)}`,
            end: h(Btn, { small: true, primary: true, disabled: retryBusy, onClick: openCleanupRun }, '立即清理'),
          })))

      const conflictRow = (item) => h('div', { className: 'dsync-conflict', key: item.id },
        h('input', {
          className: 'dsync-check',
          type: 'checkbox',
          checked: Boolean(conflictSel[item.id]),
          'aria-label': '选择冲突副本',
          onChange: (event) => toggleConflictSel(item.id, event.target.checked),
        }),
        h('div', { className: 'dsync-conflict-main' },
          h('div', { className: 'dsync-conflict-path dsync-mono' }, item.rel),
          h('div', { className: 'dsync-conflict-meta' },
            [
              item.set ? (SET_LABELS[item.set] || item.set) : '冲突副本',
              item.peer ? '与 ' + item.peer : '',
              bytesText(item.size),
              '产生于 ' + item.producedDays + ' 天前',
              item.neverAccessed ? '从未访问 · 按产生时间兜底' : '上次访问 ' + item.activeDays + ' 天前',
              item.note || '',
            ].filter(Boolean).join(' · ')),
          h('div', { className: 'dsync-conflict-tags' }, h(Tag, { kind: CONFLICT_TAG[item.tag] || 'plain' }, item.label))),
        h('div', { className: 'dsync-conflict-actions' },
          h(Btn, { small: true, disabled: retryBusy, onClick: () => keepConflict(item) }, item.keep ? '取消保留' : '保留'),
          h(Btn, { small: true, ghostDanger: true, disabled: retryBusy, onClick: () => openConflictDelete([item.id]) }, '删除')))

      const conflictFoot = h('div', { className: 'dsync-cleanup-foot' },
        h('span', { className: 'grow' }, `已选 ${selectedIds.length} 个 · 按当前规则可自动清理 ${eligibleConflicts.length} 个`),
        h(Btn, { small: true, disabled: retryBusy || !selectedIds.length, onClick: keepSelected }, '保留所选'),
        h(Btn, { small: true, ghostDanger: true, disabled: retryBusy || !selectedIds.length, onClick: () => openConflictDelete(selectedIds) }, '删除所选（移入回收站）'))

      const historyNode = (Array.isArray(state.cleanupHistory) && state.cleanupHistory.length)
        ? h('div', { className: 'dsync-history' },
          h('b', null, '最近清理记录'),
          state.cleanupHistory.slice(0, 5).map((row, index) => h('div', { key: index }, `${row.t || row.at || ''}  ${row.m || row.message || ''}`)))
        : null

      const conflictsSection = h(Group, {
        title: '冲突副本' + (conflicts.length ? `（${conflicts.length} 个）` : ''),
        note: '可手动保留或删除；「保留」的副本不会被自动清理。',
      },
        h('div', { className: 'dsync-panel' },
          conflicts.length ? conflicts.map(conflictRow) : h('div', { className: 'dsync-empty' }, '没有冲突副本。'),
          conflictFoot),
        historyNode)

      // ---- shadow workspace ------------------------------------------------
      // The switch is a backend setting (`set-shadow`). When it is off the entry
      // and every shadow group stay hidden; the shadow client itself is kept and
      // only reads the shared gate.
      const shadowToggleGroup = h(Group, {
        title: '功能',
        note: shadowWorkspaceOn ? '已开启 · 侧栏入口与影子工作区分组均已显示。' : '影子工作区默认关闭，开启后才显示入口与分组。',
      },
        h('div', { className: 'dsync-panel' },
          h(Row, {
            title: '影子工作区',
            desc: '开启后在侧栏显示「影子工作区」入口，可查看并操作已连接设备的会话；关闭时入口与视图全部隐藏。',
            end: h(Switch, { on: shadowWorkspaceOn, disabled: retryBusy, label: '影子工作区', onChange: toggleShadow }),
          })))

      const shadowDetailGroup = shadowWorkspaceOn ? h(Group, {
        title: '影子工作区',
        note: '已开启 · 侧栏入口已显示在「工作区」下方；关闭开关后入口与分组会全部隐藏。',
      },
        h('div', { className: 'dsync-panel' },
          h(Row, {
            title: '影子工作区页面',
            desc: '查看并操作已连接设备的会话；也可以从侧栏「影子工作区」入口直接进入。',
            end: h(Btn, { small: true, primary: true, onClick: openShadow }, '打开影子工作区'),
          }),
          shadowGroups.length
            ? shadowGroups.map((group, index) => h(Row, {
              key: group.deviceId + ':' + group.workspaceId + ':' + index,
              title: (group.workspaceTitle || group.workspaceId || '工作区') + ' 的工作区',
              desc: `来自「${group.deviceName || group.deviceId || '设备'}」的影子会话 · ${Array.isArray(group.sessions) ? group.sessions.length : 0} 个会话`,
            }))
            : h('div', { className: 'dsync-empty' }, shadow === null
              ? '影子工作区状态暂不可用；稍后重试或到影子工作区页面查看。'
              : '尚未选择对端工作区；在影子工作区设置里选择后这里会列出分组。'))) : null

      const logsSection = h('details', { className: 'dsync-logs' },
        h('summary', null, '最近日志', h(Glyph, { name: 'chevron', size: 14, className: 'chev' })),
        h('pre', { className: 'dsync-log-body' },
          (state.logs || []).slice(-40).map((line) => `${String(line.at || '').slice(11, 19)}  ${line.message}`).join('\n') || '—'))

      const footer = h('div', { className: 'dsync-foot' },
        h('span', { className: error ? 'dsync-error' : 'dsync-notice' }, error || STR.restart),
        h('span', { className: 'dsync-notice' },
          syncing
            ? `同步中 · 拉取 ${progress?.pulled || 0} · 合并 ${progress?.merged || 0} · 删除 ${progress?.deleted || 0} · ${bytesText(progress?.bytes || 0)}`
            : (last ? `${last.reason} · ${last.durationMs} ms` : '')))

      // ---- dialogs ---------------------------------------------------------
      const dialogNode = (() => {
        if (!modal) return null
        if (modal.kind === 'rt-risk') {
          const subRole = role === 'sub'
          const ack = Boolean(modal.ack)
          const risks = subRole
            ? [
              ['主机改动会立即覆盖本机', '删除、覆盖、批量替换会随主机同步落到本机，本机来不及确认，只能靠 .bak-sync-* 备份手动恢复。'],
              ['本机改动可能被主机版本覆盖', '两端同时修改会产生冲突副本；本机正在编辑的会话会延后到关闭后再合并。'],
              ['配置与插件会即时生效', 'profile/package.json、cordis.patch.yml 同步后可能需要重启 DSH 才能完全生效。'],
              ['带宽与磁盘占用', '大附件、插件依赖会持续接收，同时保留 .bak-sync-* 备份。'],
            ]
            : [
              ['改动会立即扩散', '删除、覆盖、批量替换会在几秒内出现在每台设备上，只能靠 .bak-sync-* 备份手动恢复，没有一键撤销。'],
              ['正在编辑的会话可能被覆盖', '同一文件两端同时修改会产生冲突副本；本机打开中的会话会延后到关闭后再合并。'],
              ['配置与插件会即时生效', 'profile/package.json、cordis.patch.yml 同步后可能需要重启 DSH 才能完全生效。'],
              ['带宽与磁盘占用', '大附件、插件依赖会在局域网内持续传输，同时保留 .bak-sync-* 备份。'],
            ]
          return h(Modal, {
            title: '开启实时同步前，请先了解这些',
            desc: subRole
              ? '实时同步会在主机文件变化后 1–2 秒内自动同步到本机，不再逐次确认。'
              : '实时同步会在文件保存后 1–2 秒内自动同步到所有已连接设备，不再逐次确认。',
            icon: 'warn',
            tone: 'warn',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消（不开启）'),
              h(Btn, { key: 'next', primary: true, disabled: !ack, onClick: realtimeNext }, '继续'),
            ],
          },
            h('div', { className: 'dsync-risk-list' },
              risks.map((risk, index) => h('div', { className: 'dsync-risk', key: index },
                h('span', { className: 'dsync-risk-no' }, String(index + 1)),
                h('div', null, h('b', null, risk[0]), risk[1])))),
            h('div', { className: 'dsync-note-box' }, '建议先在「同步范围」中只保留会话与工作区，确认稳定后再扩大范围；开启前请确认重要数据已有备份。'),
            h('label', { className: 'dsync-ack' + (ack ? ' checked' : '') },
              h('input', { type: 'checkbox', checked: ack, onChange: (event) => setModal((prev) => prev && prev.kind === 'rt-risk' ? { ...prev, ack: event.target.checked } : prev) }),
              h('span', null, '我已阅读并理解以上风险，确认本机重要数据已有备份')))
        }
        if (modal.kind === 'rt-final') {
          const subRole = role === 'sub'
          const waiting = countdown > 0
          return h(Modal, {
            title: '再次确认：开启实时同步',
            desc: subRole
              ? '这是第二次确认。确认后立即开始接收主机改动，并保存为默认开启状态（下次启动 DSH 仍然生效）。'
              : '这是第二次确认。确认后立即生效，并保存为默认开启状态（下次启动 DSH 仍然生效）。',
            icon: 'warn',
            tone: 'warn',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', danger: true, disabled: waiting, onClick: confirmRealtimeOn }, waiting ? `请稍候（${countdown}）` : '确认开启实时同步'),
            ],
          },
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '本机身份'), h('b', null, subRole ? '子机' : '主机')),
              h('div', null, h('span', null, '目标设备'), h('b', null, subRole ? '1 台主机（只接收）' : realtimeTargets)),
              h('div', null, h('span', null, '同步方向'), h('b', null, subRole ? '主机 → 本机（接收）' : '本机 → 子机（推送）')),
              h('div', null, h('span', null, '同步范围'), h('b', null, `${enabledSetCount} 项 · ${enabledFiles} 个文件`))),
            h('div', { className: 'dsync-note-box' }, '覆盖前会保留 .bak-sync-* 备份；确认后可在「同步模式」中随时暂停，暂停只停止自动同步，不会撤回已同步的文件。'))
        }
        if (modal.kind === 'rt-off') {
          return h(Modal, {
            title: '暂停实时同步？',
            desc: '暂停后回到手动模式：不再自动同步，数据只在点击设备行的「推送 / 覆盖本地」时传输。',
            icon: 'info',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', primary: true, onClick: confirmRealtimeOff }, '暂停实时同步'),
            ],
          }, h('div', { className: 'dsync-note-box' }, '已同步的文件不受影响；关闭状态会被记住，再次开启仍需两次确认。'))
        }
        if (modal.kind === 'discover') {
          const selected = modal.peerId
          const list = nearby.length
            ? nearby.map((peer) => h('button', {
              key: peer.deviceId,
              className: 'dsync-pick' + (selected === peer.deviceId ? ' selected' : ''),
              type: 'button',
              onClick: () => setModal((prev) => prev && prev.kind === 'discover' ? { ...prev, peerId: peer.deviceId } : prev),
            },
              h('span', { className: 'dsync-pick-icon' }, h(Glyph, { name: 'laptop', size: 17 })),
              h('span', { className: 'dsync-pick-main' },
                h('span', { className: 'dsync-pick-title' }, peer.name || String(peer.deviceId).slice(0, 8), h(Tag, { kind: 'plain' }, peer.sameAccount ? '同账号' : '局域网')),
                h('span', { className: 'dsync-pick-meta dsync-mono' }, `${peer.host || '—'}:${peer.port || '—'} · ${peer.deviceId}`)),
              h('span', { className: 'dsync-radio' })))
            : h('div', { className: 'dsync-empty' }, '暂未发现新设备。确认两台电脑在同一局域网，且都安装了本插件。')
          return h(Modal, {
            title: '连接新设备',
            desc: '同一局域网内发现以下设备。选择一台开始配对；第一台设备会先确认本机身份（主机 / 子机）。',
            icon: 'sync',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'rescan', disabled: retryBusy, onClick: () => { void load(true); showToast('正在重新扫描局域网…') } }, '重新扫描'),
              h(Btn, { key: 'next', primary: true, disabled: !selected, onClick: discoverNext }, '下一步'),
            ],
          },
            list,
            h('div', { className: 'dsync-note-box' }, '发现不了对方时，可以在另一台设备面板上读取「IP:监听端口」后手动添加。'),
            h('div', { className: 'dsync-field', style: { maxWidth: '100%' } },
              h('input', {
                className: 'dsync-input',
                value: manualAddress,
                placeholder: '192.168.1.20:49683',
                'aria-label': '手动添加设备地址',
                onChange: (event) => setManualAddress(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void submitManual() },
              }),
              h(Btn, { small: true, disabled: retryBusy || !String(manualAddress || '').trim(), onClick: () => void submitManual() }, '添加')))
        }
        if (modal.kind === 'role') {
          const picked = modal.role
          return h(Modal, {
            title: '选择本机身份',
            desc: '这是第一台要连接的设备「' + (nearby.filter((peer) => peer.deviceId === modal.peerId).map((peer) => peer.name)[0] || '对端设备') + '」。请先确认本机在同步关系中的身份，选中后固定不变。',
            icon: 'sync',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'back', onClick: () => setModal({ kind: 'discover', peerId: modal.peerId }) }, '返回'),
              h(Btn, { key: 'next', primary: true, disabled: !picked || retryBusy, onClick: roleNext }, '下一步'),
            ],
          },
            h('button', {
              className: 'dsync-choice' + (picked === 'host' ? ' selected' : ''),
              type: 'button',
              onClick: () => setModal((prev) => prev && prev.kind === 'role' ? { ...prev, role: 'host' } : prev),
            },
              h('span', { className: 'dsync-radio' }),
              h('span', { className: 'dsync-choice-main' },
                h('span', { className: 'dsync-choice-title' }, '本机作为主机 ', h(Tag, { kind: 'blue' }, '对方默认为子机')),
                h('span', { className: 'dsync-choice-desc' }, '本机可以向对方推送，之后连接的其他设备也默认为子机；一台主机可同步多台子机。'))),
            h('button', {
              className: 'dsync-choice' + (picked === 'sub' ? ' selected' : ''),
              type: 'button',
              onClick: () => setModal((prev) => prev && prev.kind === 'role' ? { ...prev, role: 'sub' } : prev),
            },
              h('span', { className: 'dsync-radio' }),
              h('span', { className: 'dsync-choice-main' },
                h('span', { className: 'dsync-choice-title' }, '本机作为子机 ', h(Tag, { kind: 'warn' }, '对方默认为主机')),
                h('span', { className: 'dsync-choice-desc' }, '本机仅被动接收对方同步，推送关闭；子机只能连接这一台主机，不能再连接其他子机。'))),
            h('div', { className: 'dsync-warn-box' }, '身份选中后固定不变，切换主机 / 子机需先断开全部连接再重新发起。主机功能与子机功能互斥：子机状态会隐藏主机相关操作，反之亦然。'),
            h('div', { className: 'dsync-note-box' }, '对端会收到相反身份并需确认；双方身份冲突时配对会被拒绝。'))
        }
        if (modal.kind === 'sas') {
          const peer = nearby.filter((item) => item.deviceId === modal.peerId)[0]
          const localRole = modal.localRole || role
          const peerRole = localRole === 'host' ? 'sub' : 'host'
          return h(Modal, {
            title: '核对配对码',
            desc: '请确认另一台电脑显示了相同的 6 位数字，然后各自点击「确认配对」。',
            icon: 'lock',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', primary: true, disabled: retryBusy, onClick: confirmPair }, '确认配对'),
            ],
          },
            h('div', { className: 'dsync-sas' }, sasText(modal.sas) || '⋯⋯⋯'),
            h('div', { className: 'dsync-sas-hint' }, `${(peer && peer.name) || modal.peerId} · ${(peer && peer.host) || '—'}`),
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '本机身份'), h('b', null, localRole === 'host' ? '主机' : '子机')),
              h('div', null, h('span', null, '对端身份'), h('b', null, peerRole === 'host' ? '主机' : '子机'))),
            h('div', { className: 'dsync-note-box' }, '数字不一致时请取消——可能存在中间人风险，或两台设备不在同一配对流程中。'),
            h('div', { className: 'dsync-warn-box' }, '身份会随配对请求发给对端确认。若双方选择冲突（都想当主机 / 都想当子机），配对会被拒绝并要求重新选择。'))
        }
        if (modal.kind === 'disconnect-all') {
          return h(Modal, {
            title: '断开全部连接？',
            desc: '断开后所有配对关系解除，本机身份解锁；下次连接设备时重新选择主机 / 子机。已同步的文件不会删除。',
            icon: 'warn',
            tone: 'warn',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', danger: true, onClick: confirmDisconnectAll }, '断开全部连接'),
            ],
          },
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '当前身份'), h('b', null, roleTitle)),
              h('div', null, h('span', null, '将断开'), h('b', null, peers.length + ' 台设备'))),
            h('div', { className: 'dsync-warn-box' }, '主机 / 子机为互斥身份。切换身份必须先断开全部连接重新发起；断开期间不会同步，也不会自动重连。已同步的文件会保留，不会回滚。'))
        }
        if (modal.kind === 'unpair') {
          const peer = peers.filter((item) => item.deviceId === modal.peerId)[0]
          if (!peer) return null
          const peerRole = roleOfPeer(peer)
          return h(Modal, {
            title: '解除与 ' + (peer.name || String(peer.deviceId).slice(0, 8)) + ' 的配对？',
            desc: '解除后将无法与该设备同步，重新连接需要再次配对。已同步的文件会保留在本机。',
            icon: 'warn',
            tone: 'warn',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', danger: true, onClick: confirmUnpair }, '解除配对'),
            ],
          }, h('div', { className: 'dsync-note-box' },
            (peerRole === 'host'
              ? '这台设备当前是本机的主机；解除后不影响其它设备。'
              : '这台设备当前是本机的子机；解除后不影响其它设备。')
            + '身份仍保持锁定，切换主机 / 子机需先「断开全部连接」。'))
        }
        if (modal.kind === 'push' || modal.kind === 'pull') {
          const peer = peers.filter((item) => item.deviceId === modal.peerId)[0]
          if (!peer) return null
          const isPush = modal.kind === 'push'
          const fromHost = Boolean(preview && preview.fromHost)
          const count = preview && Number.isFinite(preview.count) ? preview.count : null
          const directionText = isPush ? '推送' : (fromHost ? '拉取' : '覆盖')
          return h(Modal, {
            title: isPush
              ? '推送到 ' + (peer.name || '对端')
              : (fromHost ? '从 ' + (peer.name || '主机') + ' 拉取' : '用 ' + (peer.name || '对端') + ' 覆盖本地'),
            desc: isPush
              ? '本次会把下列文件推送到对端。对端同名文件会被覆盖并保留 .bak 备份，配置类文件除外。'
              : (fromHost
                ? '本次会从主机拉取下列文件覆盖本机同名文件；本机独有的文件不会被删除，被覆盖文件保留 .bak 备份。'
                : '本次会用对端版本覆盖本机下列文件；本机独有的文件不会被删除，被覆盖文件保留 .bak 备份。'),
            icon: isPush ? 'up' : 'down',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, {
                key: 'confirm',
                primary: isPush,
                danger: !isPush,
                disabled: retryBusy,
                onClick: isPush ? confirmPush : confirmPull,
              }, isPush ? '确认推送这 ' + (count == null ? '?' : count) + ' 个文件' : (fromHost ? '确认拉取' : '确认覆盖本地')),
            ],
          },
            h('div', { className: 'dsync-dir' },
              h(Tag, { kind: 'plain' }, isPush ? '本机' : (peer.name || '对端')),
              h('span', null, '→'),
              h(Tag, { kind: 'blue' }, isPush ? (peer.name || '对端') : '本机'),
              h('span', null, isPush ? '本机 → 对端' : '对端 → 本机')),
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '同步范围'), h('b', null, `${enabledSetCount} 项 · ${enabledFiles} 个文件`)),
              h('div', null, h('span', null, '本次传输'), h('b', null, (count == null ? '—' : count + ' 个文件') + ' · ' + bytesText(preview && preview.bytes))),
              h('div', null, h('span', null, '最近同步'), h('b', null, peer.lastSyncAt ? timeText(peer.lastSyncAt) : '—')),
              h('div', null, h('span', null, '冲突处理'), h('b', null, '另存 conflicts/ 副本'))),
            preview && preview.fallback
              ? h('div', { className: 'dsync-warn-box' }, isPush
                ? '无法获取本次推送文件清单（预览失败），确认后仍会按当前范围执行。'
                : '无法获取本次文件清单（预览失败），确认后仍会用对端版本覆盖本机同名文件，并保留 .bak-sync-* 备份。')
              : h(ChangeList, { preview, page, direction: directionText, onPage: setPage }),
            h('div', { className: 'dsync-note-box' }, isPush
              ? '对端被覆盖的文件会保留 .bak-sync-* 备份；cordis.patch.yml 等配置类文件受保护，不会被覆盖。'
              : '本机被覆盖的文件会保留 .bak-sync-* 备份；正在编辑的会话会延后合并。'))
        }
        if (modal.kind === 'sync-now') {
          const direction = (preview && preview.kind) || settings.immediate
          const isHost = direction !== 'pull'
          const hostName = onlineHost ? onlineHost.name : (hostPeer ? hostPeer.name : '主机')
          const target = isHost ? onlineSubsText : (onlineHost ? onlineHost.name : hostName)
          const count = preview && Number.isFinite(preview.count) ? preview.count : null
          return h(Modal, {
            title: isHost ? '立即同步：推送到子机' : '立即同步：从主机拉取',
            desc: isHost
              ? '把本机变更推送到全部在线子机；请核对下列文件后确认。'
              : '从主机「' + hostName + '」拉取最新变更；请核对下列文件后确认。',
            icon: isHost ? 'up' : 'down',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', primary: true, disabled: retryBusy, onClick: confirmImmediate },
                isHost ? '确认推送这 ' + (count == null ? '?' : count) + ' 个文件' : '确认拉取'),
            ],
          },
            h('div', { className: 'dsync-dir' },
              h(Tag, { kind: 'plain' }, isHost ? '本机' : hostName),
              h('span', null, '→'),
              h(Tag, { kind: 'blue' }, isHost ? '全部在线子机' : '本机'),
              h('span', null, isHost ? '推送' : '拉取')),
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '目标'), h('b', null, target)),
              h('div', null, h('span', null, '本次文件'), h('b', null, (count == null ? '—' : count + ' 个') + ' · ' + bytesText(preview && preview.bytes))),
              h('div', null, h('span', null, '同步范围'), h('b', null, enabledSetCount + ' 项')),
              h('div', null, h('span', null, '实时同步'), h('b', null, settings.realtime ? '已开启（本次仍为手动确认）' : '未开启'))),
            preview && preview.fallback
              ? h('div', { className: 'dsync-warn-box' }, '无法获取本次文件清单（后端暂未返回），确认后仍会执行一次手动同步。')
              : h(ChangeList, { preview, page, direction: isHost ? '推送' : '拉取', onPage: setPage }),
            h('div', { className: 'dsync-note-box' }, isHost
              ? '推送只影响目标设备，不会删除本机文件；对端被覆盖文件保留 .bak-sync-* 备份。'
              : '拉取只覆盖本机同名文件，本机独有文件不会删除；被覆盖文件保留 .bak-sync-* 备份。'))
        }
        if (modal.kind === 'conflict-delete') {
          const ids = Array.isArray(modal.ids) ? modal.ids : []
          const items = conflicts.filter((item) => ids.includes(item.id))
          if (!items.length) return null
          const size = items.reduce((sum, item) => sum + item.size, 0)
          const previewRows = items.slice(0, 3).map((item, index) => h('div', { className: 'dsync-conflict-path dsync-mono', key: index }, item.rel))
          if (items.length > 3) previewRows.push(h('div', { className: 'dsync-conflict-meta', key: 'more' }, '…等 ' + items.length + ' 个'))
          return h(Modal, {
            title: '删除 ' + items.length + ' 个冲突副本？',
            desc: settings.cleanup.recycle ? '删除后移入回收站，7 天内可以恢复。' : '回收站已关闭，删除后不可恢复。',
            icon: 'warn',
            tone: 'warn',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', danger: true, disabled: retryBusy, onClick: confirmConflictDelete }, '删除'),
            ],
          },
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '副本数量'), h('b', null, items.length + ' 个')),
              h('div', null, h('span', null, '占用空间'), h('b', null, bytesText(size)))),
            h('div', { className: 'dsync-note-box' }, previewRows))
        }
        if (modal.kind === 'cleanup-run') {
          return h(Modal, {
            title: '立即清理冲突副本？',
            desc: '按当前规则删除长期未访问、且没有被「保留」的冲突副本。',
            icon: 'refresh',
            tone: 'info',
            onCancel: closeModal,
            foot: [
              h(Btn, { key: 'cancel', onClick: closeModal }, '取消'),
              h(Btn, { key: 'confirm', primary: true, disabled: retryBusy || !eligibleConflicts.length, onClick: confirmCleanupRun }, '立即清理'),
            ],
          },
            h('div', { className: 'dsync-summary' },
              h('div', null, h('span', null, '可清理数量'), h('b', null, eligibleConflicts.length + ' 个')),
              h('div', null, h('span', null, '可释放空间'), h('b', null, bytesText(eligibleBytes))),
              h('div', null, h('span', null, '保留时长'), h('b', null, settings.cleanup.retentionDays === 0 ? '永久保留' : settings.cleanup.retentionDays + ' 天')),
              h('div', null, h('span', null, '回收站'), h('b', null, recycleHint))),
            h('div', { className: 'dsync-note-box' }, eligibleConflicts.length
              ? '只清理受管目录（<stateDir>/conflicts 与已启用同步范围内的冲突副本/备份）里的文件；其它位置的副本会保留并计入 skipped。清理后可在「最近清理记录」中查看本次释放的空间。'
              : '当前没有符合条件的副本。可以调整保留时长，或等待下一次自动清理。'))
        }
        return null
      })()

      const toastNode = toast
        ? h('div', { className: 'dsync-toast-wrap' },
          h('div', { className: 'dsync-toast dsync-toast-' + (toast.kind || 'info') },
            h(Glyph, { name: toast.kind === 'success' ? 'check' : toast.kind === 'danger' ? 'warn' : 'info', size: 15 }),
            h('span', null, toast.message)))
        : null

      return h('div', { className: 'dsync-shell' },
        h('div', { className: 'dsync-page' },
          h('header', { className: 'dsync-head' },
            h('div', { className: 'dsync-heading' },
              h('h1', { className: 'dsync-title' }, STR.title),
              h('p', { className: 'dsync-intro' }, STR.subtitle)),
            h('div', { className: 'dsync-toolbar' },
              h('span', { className: 'dsync-pill' },
                h('span', { className: 'dsync-dot ' + (state.running ? 'ok' : 'err') }),
                state.running ? STR.running : STR.stopped),
              settings.realtime ? h('span', { className: 'dsync-pill dsync-pill-warn' }, h('span', { className: 'dsync-dot warn' }), '实时同步中') : null,
              h(Btn, { small: true, disabled: retryBusy, onClick: () => { void load(false) } }, STR.refresh))),
          identity,
          localSection,
          syncSection,
          peersSection,
          setsSection,
          cleanupSection,
          conflictsSection,
          shadowToggleGroup,
          shadowDetailGroup,
          logsSection,
          footer),
        dialogNode,
        toastNode)
    }

    function Panel(props) {
      return h(PanelBody, { ctx: props.ctx })
    }

    // -----------------------------------------------------------------------
    // Shadow Workspace UI (merged from dsh-plugin-shadow-workspace 0.1.1).
    //
    // The original plugin shipped its own module-loader wrapper; that factory
    // body lives here now so this bundle makes exactly one loader call.
    // `require` is passed through: the body only needs `react`. Its style id
    // (`shadow-workspace-style`) and slot keys (`shadow-workspace*`) are
    // distinct from the device-sync panel above, so neither UI overwrites the
    // other.
    // -----------------------------------------------------------------------
    function createShadowClient(require, gate = null) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ROUTE = '/plugins/dsh-plugin-dsh-sync/shadow'
    const DATA_ROUTE = '/plugins/dsh-plugin-dsh-sync/shadow/rpc'
    const SETTINGS_KEY = 'shadow-workspace'
    const GROUP_PREFIX = 'shadow-workspace:'
    const STYLE_ID = 'shadow-workspace-style'
    const NS = 'shadow'
    const PANEL_POLL_MS = 4000
    const EVENT_WAIT_MS = 12000

    // Local display aliases for peer workspaces (A-side only). The bridge keeps
    // advertising the real workspace title; renaming only changes how this client
    // renders it in the launcher and the settings list.
    const ALIAS_KEY = 'sdw-workspace-aliases'
    const aliasKeyOf = (group) => `${(group && group.deviceId) || ''}:${(group && group.workspaceId) || ''}`
    const readAliases = () => {
      try {
        const value = JSON.parse(window.localStorage.getItem(ALIAS_KEY) || '{}')
        return value && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }
    const workspaceAlias = (group) => {
      if (!group) return ''
      const value = readAliases()[aliasKeyOf(group)]
      return typeof value === 'string' ? value : ''
    }
    const setWorkspaceAlias = (group, name) => {
      if (!group) return
      const aliases = readAliases()
      const value = String(name == null ? '' : name).trim()
      if (value) aliases[aliasKeyOf(group)] = value
      else delete aliases[aliasKeyOf(group)]
      try { window.localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases)) } catch {}
      try { window.dispatchEvent(new CustomEvent('shadow:aliases')) } catch {}
    }

    const zh = {
      title: '影子工作区',
      subtitle: '在另一台电脑上真实运行，在这里查看和审批',
      tabShare: '本机共享',
      tabDisplay: '显示对端',
      shareMaster: '共享本机工作区',
      shareMasterDesc: '允许已配对设备在这里新建会话、发送消息并等待你的审批',
      shareOff: '共享已关闭',
      shareOffDesc: '打开开关并勾选至少一个工作区后，对端才能连接',
      workspaces: '共享的工作区',
      workspacesEmpty: '没有工作区',
      devices: '已配对设备',
      devicesEmpty: '还没有已配对的设备。先在「设备同步」里完成配对。',
      online: '在线',
      offline: '离线',
      untrusted: '未配对',
      attached: '本次已接入',
      presenceStale: '接入已过期',
      sessionGone: '会话已失效，请新建会话',
      audit: '最近操作',
      auditEmpty: '暂无记录',
      auditClear: '清空记录',
      kill: '全部拒绝并断开',
      killHint: '立即拒绝所有等待中的审批、清空共享白名单并停止接受新消息',
      killed: '已执行断开',
      displayMaster: '显示对端的影子工作区',
      displayMasterDesc: '在左侧栏显示已选设备的共享工作区',
      displayPeer: '对端设备',
      displayPeerEmpty: '选择一台已配对且在线的设备',
      displayNoPeer: '请选择要显示的对端设备',
      displayOff: '显示已关闭',
      syncMissing: '需要 dsh-sync 0.5.1+（未检测到扩展通道）',
      noGroups: '对端还没有共享任何工作区，或共享开关未打开。',
      timeNow: '刚刚',
      unitMinutes: '分钟',
      unitHours: '小时',
      unitDays: '天',
      unitMonths: '个月',
      unitYears: '年',
      pendingApproval: '待审批',
      refresh: '刷新',
      workspaceActions: '工作区操作',
      sessionActions: '会话操作',
      menuOpenSession: '打开会话',
      menuCopyId: '复制会话 ID',
      agoSuffix: '前',
      statusIdle: '空闲',
      peerWorkspaces: '对端共享工作区',
      activityRead: '正在读取文件',
      activityCommand: '正在运行命令',
      activitySearch: '正在搜索',
      activityEdit: '正在编辑文件',
      activityWrite: '正在写入文件',
      activityOther: '正在处理…',
      inputCommands: '添加文件或调用指令',
      rename: '重命名',
      renameSave: '保存',
      renameCancel: '取消',
      voiceInput: '语音输入',
      modelMenuModel: '模型',
      modelSearch: '搜索模型…',
      modelMenuEmpty: '没有匹配的模型',
      effortDefault: 'Default',
      newSession: '新会话',
      settings: '设置',
      expand: '展开',
      collapse: '收起',
      sessions: '影子会话',
      sessionsEmpty: '这个工作区还没有影子会话',
      back: '返回对话',
      backPanel: '返回设置',
      send: '发送',
      stop: '停止',
      sending: '发送中…',
      thinking: '执行中…',
      thinkTitle: '思考',
      thinkRunning: '思考中…',
      thinkChars: '字',
      toolCall: '工具调用',
      toolResult: '工具结果',
      toolRead: '读取',
      toolWrite: '写入',
      toolEdit: '编辑',
      toolGrep: '搜索',
      toolGlob: '查找',
      toolCommand: '命令',
      toolJob: '任务',
      toolWeb: '联网',
      toolOther: '工具',
      toolSkill: '技能',
      approvalEvent: '审批',
      approvedOnce: '已允许一次',
      rejectedOnce: '已拒绝',
      approvalUnavailable: '审批不可用',
      toolArgs: '参数',
      toolOutput: '输出',
      toolEmptyOutput: '（没有输出）',
      toolAdded: '新增',
      toolRemoved: '删除',
      toolTruncatedLines: '…还有 {n} 行',
      commandExited: '结束',
      commandRunning: '执行中…',
      todoTitle: '待办',
      jobTitle: '后台任务',
      jobRunning: '运行中',
      jobSettled: '已结束',
      jobFailed: '失败',
      // Native-like chat chrome (0.10.0).
      processRunning: '正在处理…',
      processDone: '已完成',
      processThought: '已思考',
      toolCallsUnit: '次工具调用',
      commandsUnit: '条命令',
      jobsUnit: '个后台任务',
      errorsUnit: '个错误',
      usedTime: '用时',
      rowRunning: '运行中',
      copy: '复制',
      copied: '已复制',
      copyMessage: '复制回复',
      toBottom: '回到底部',
      inputHint: 'Enter 发送 · Shift+Enter 换行',
      emptyTitle: '开始新的对话',
      emptyHint: '在下方输入消息；Enter 发送，Shift+Enter 换行。',
      loadingHistory: '载入对话…',
      linesUnit: '行',
      matchesUnit: '处匹配',
      filesUnit: '个文件',
      pathsUnit: '个路径',
      modelLabel: '模型',
      modelDefault: '默认模型',
      modelSelect: '选择模型',
      modelSwitching: '切换中…',
      modelSwitchFailed: '切换模型失败',
      modelListFailed: '模型列表加载失败',
      modelNoCatalog: '对端未提供模型列表',
      effortLabel: '推理等级',
      sandboxLabel: '沙箱',
      permissionLabel: '权限',
      cwdLabel: '工作目录',
      eventModel: '模型',
      eventSandbox: '沙箱',
      eventPermission: '权限',
      eventCwd: '工作目录',
      lastTextLabel: '最近',
      newSessionModel: '模型',
      sessionCountUnit: '个会话',
      expandRest: '展开其余',
      peerGroups: '对端工作区',
      groupToday: '今天',
      groupYesterday: '昨天',
      groupEarlier: '更早',
      // Interactive questions / plan review (0.8.0).
      questionTitle: '需要你回答',
      questionDetail: '查看说明',
      questionCustom: '自定义回答（可留空）',
      questionSkip: '跳过此题',
      questionSkipAll: '全部跳过',
      questionSubmit: '提交回答',
      questionMissing: '还有问题未回答',
      questionAnswered: '已回答',
      questionSkipped: '（已跳过）',
      questionCancelledHint: '已要求修改，等待对端更新。',
      questionExpired: '问题已过期，交回本机界面处理。',
      questionBadAnswer: '回答无效',
      planReviewTitle: '计划待审',
      planViewFull: '查看全文',
      planCollapse: '收起全文',
      planRequestChanges: '要求修改',
      planApprove: '同意执行',
      // Chunked file transfer (0.9.0).
      uploadsReceive: '接收对端推送的文件',
      uploadsReceiveOn: '已开启，已配对设备可以推送文件到本机',
      uploadsReceiveOff: '未开启，对端无法推送文件',
      uploadsDirHint: '保存目录',
      uploadsTitle: '推送文件到对端',
      uploadsDesc: '分块传输并校验 sha256；对端保存到 shadow-uploads',
      uploadsFile: '已选文件',
      uploadsSend: '推送文件到对端',
      uploadsProgress: '已推送',
      uploadsDone: '已送达',
      uploadsFailed: '推送失败',
      uploadsNoFile: '请先选择文件',
      uploadsReceiveOffPeer: '对端未开启文件接收',
      uploadsHash: 'sha256',
      uploadsBytes: '大小',
      pluginVersion: '影子插件',
      peerVersion: '对端',
      latestEvents: '最近事件',
      noReplyNeeded: '已提交，等待对端继续。',
      statusRunning: '运行中',
      statusWaiting: '等待审批',
      statusDone: '完成',
      statusFailed: '失败',
      statusStopped: '已停止',
      statusIdle: '空闲',
      statusDisconnected: '已断开',
      statusLost: '会话已失效',
      approve: '允许一次',
      reject: '拒绝',
      toolCall: '工具调用',
      toolResult: '工具结果',
      approvals: '待审批',
      loading: '读取中…',
      inputPlaceholder: '发消息或创建任务，/ 调用指令，@ 文件或对话',
      permFull: '完全权限',
      permWorkspace: '工作区内修改',
      permReadonly: '仅可查看',
      // Shadow composer controls (0.10.25): permission presets, attachments, voice.
      permAuto: '自动审查',
      permCustom: '自定义',
      permMenuTitle: '访问模式',
      permSwitching: '切换中…',
      permSwitchFailed: '切换权限失败',
      permRiskTitle: '切换到「{name}」？',
      permRiskBody: '该模式会让对端会话在没有逐步审批的情况下执行命令或修改文件，请确认你了解风险。',
      permRiskAck: '我已了解风险，并愿意继续',
      permRiskConfirm: '确认切换',
      permRiskCancel: '取消',
      addMenuAdd: '添加',
      addMenuFile: '图片或文件…',
      addMenuPush: '推送文件到对端…',
      attachUploading: '上传中',
      attachReady: '已就绪',
      attachFailed: '上传失败',
      attachTooLarge: '文件过大',
      attachTooMany: '附件数量超出上限',
      attachRemove: '移除附件',
      attachRetryHint: '附件上传失败，移除后重试。',
      attachSending: '发送中…',
      voiceRequesting: '请允许使用麦克风…',
      voiceRecording: '录音中',
      voiceTranscribing: '识别中…',
      voiceCancel: '取消',
      voiceStop: '停止',
      voiceEmpty: '未识别到语音',
      voiceFailed: '语音识别失败：',
      voiceDenied: '麦克风权限未开启，请在浏览器和系统设置中允许访问。',
      voiceNoDevice: '麦克风不可用，请检查输入设备。',
      voiceUnsupported: '当前浏览器不支持录音。',
      voiceUnavailable: '本机未启用语音输入（缺少 speechToText 服务）。',
      voiceUnprepared: '语音识别尚未就绪。点击「下载并准备」后会自动下载模型，准备完成再按麦克风录音。',
      voicePreparing: '正在准备模型…',
      voicePrepare: '下载并准备',
      voiceReady: '语音输入',
      voiceInterrupted: '录音中断，请重试。',
      toolQuestion: '提问',
      questionWaiting: '等待回答',
      questionReview: '查看回答',
      questionUnanswered: '未回答',
      emptyText: '（没有文字输出）',
      reconnect: '重新连接',
      retry: '重试',
      refresh: '刷新',
      groupSuffix: '的工作区',
      debugLog: '调试日志',
      truncated: '（内容已截断）',
      auditAt: '时间',
      auditOp: '操作',
      auditResult: '结果',
      workspaceCount: '个会话',
      unknownError: '未知错误',
      displayGroups: '对端工作区',
      sharingNow: '共享中',
      notSharing: '未共享',
      refreshFailed: '刷新失败',
      connectHint: 'A 端电脑需要打开「共享本机工作区」并勾选工作区。',
    }
    const en = {
      title: 'Shadow Workspaces',
      subtitle: 'Sessions that really run on another computer',
      tabShare: 'Share this device',
      tabDisplay: 'Display peer',
      shareMaster: 'Share local workspaces',
      shareMasterDesc: 'Allow paired devices to create sessions, send messages and wait for your approval here',
      shareOff: 'Sharing is off',
      shareOffDesc: 'Turn it on and tick at least one workspace before a peer can connect',
      workspaces: 'Shared workspaces',
      workspacesEmpty: 'No workspace',
      devices: 'Paired devices',
      devicesEmpty: 'No paired device yet. Pair in Device Sync first.',
      online: 'online',
      offline: 'offline',
      untrusted: 'unpaired',
      attached: 'attached',
      presenceStale: 'presence stale',
      sessionGone: 'Session expired — start a new one',
      audit: 'Recent activity',
      auditEmpty: 'No records',
      auditClear: 'Clear',
      kill: 'Reject all and disconnect',
      killHint: 'Reject every pending approval, clear the shared workspace list and stop accepting prompts',
      killed: 'Disconnected',
      displayMaster: 'Display peer shadow workspaces',
      displayMasterDesc: 'Show the selected peer workspaces in the left sidebar',
      displayPeer: 'Peer device',
      displayPeerEmpty: 'Choose a paired, online device',
      displayNoPeer: 'Choose the peer device to display',
      displayOff: 'Display is off',
      syncMissing: 'dsh-sync 0.5.1+ is required (extension channel not detected)',
      noGroups: 'The peer shares no workspace yet, or its sharing switch is off.',
      timeNow: 'now',
      unitMinutes: 'min',
      unitHours: 'h',
      unitDays: 'd',
      unitMonths: 'mo',
      unitYears: 'y',
      pendingApproval: 'Pending review',
      refresh: 'Refresh',
      workspaceActions: 'Workspace actions',
      sessionActions: 'Session actions',
      menuOpenSession: 'Open session',
      menuCopyId: 'Copy session ID',
      agoSuffix: ' ago',
      statusIdle: 'Idle',
      peerWorkspaces: 'Peer shared workspaces',
      activityRead: 'Reading file',
      activityCommand: 'Running command',
      activitySearch: 'Searching',
      activityEdit: 'Editing file',
      activityWrite: 'Writing file',
      activityOther: 'Working…',
      inputCommands: 'Add files or call a command',
      rename: 'Rename',
      renameSave: 'Save',
      renameCancel: 'Cancel',
      voiceInput: 'Voice input',
      modelMenuModel: 'Model',
      modelSearch: 'Search models…',
      modelMenuEmpty: 'No matching models',
      effortDefault: 'Default',
      newSession: 'New session',
      settings: 'Settings',
      expand: 'Expand',
      collapse: 'Collapse',
      sessions: 'Shadow sessions',
      sessionsEmpty: 'No shadow session in this workspace yet',
      back: 'Back to conversation',
      backPanel: 'Back to settings',
      send: 'Send',
      stop: 'Stop',
      sending: 'Sending…',
      thinking: 'Running…',
      thinkTitle: 'Thinking',
      thinkRunning: 'Thinking…',
      thinkChars: 'chars',
      toolCall: 'Tool call',
      toolResult: 'Tool result',
      toolRead: 'Read',
      toolWrite: 'Write',
      toolEdit: 'Edit',
      toolGrep: 'Search',
      toolGlob: 'Glob',
      toolCommand: 'Command',
      toolJob: 'Job',
      toolWeb: 'Web',
      toolOther: 'Tool',
      toolSkill: 'Skill',
      approvalEvent: 'Approval',
      approvedOnce: 'allowed once',
      rejectedOnce: 'rejected',
      approvalUnavailable: 'unavailable',
      toolArgs: 'Arguments',
      toolOutput: 'Output',
      toolEmptyOutput: '(no output)',
      toolAdded: 'added',
      toolRemoved: 'removed',
      toolTruncatedLines: '… {n} more lines',
      commandExited: 'finished',
      commandRunning: 'Running…',
      todoTitle: 'Todos',
      jobTitle: 'Background job',
      jobRunning: 'running',
      jobSettled: 'settled',
      jobFailed: 'failed',
      // Native-like chat chrome (0.10.0).
      processRunning: 'Working…',
      processDone: 'Done',
      processThought: 'Thought for',
      toolCallsUnit: 'tool calls',
      commandsUnit: 'commands',
      jobsUnit: 'jobs',
      errorsUnit: 'errors',
      usedTime: 'took',
      rowRunning: 'running',
      copy: 'Copy',
      copied: 'Copied',
      copyMessage: 'Copy reply',
      toBottom: 'Back to bottom',
      inputHint: 'Enter to send · Shift+Enter for a new line',
      emptyTitle: 'Start the conversation',
      emptyHint: 'Type a message below: Enter sends, Shift+Enter adds a new line.',
      loadingHistory: 'Loading conversation…',
      linesUnit: 'lines',
      matchesUnit: 'matches',
      filesUnit: 'files',
      pathsUnit: 'paths',
      modelLabel: 'Model',
      modelDefault: 'Default model',
      modelSelect: 'Select model',
      modelSwitching: 'Switching…',
      modelSwitchFailed: 'Model switch failed',
      modelListFailed: 'Failed to load models',
      modelNoCatalog: 'The peer exposes no model catalogue',
      effortLabel: 'Reasoning level',
      sandboxLabel: 'Sandbox',
      permissionLabel: 'Permission',
      cwdLabel: 'Working directory',
      eventModel: 'Model',
      eventSandbox: 'Sandbox',
      eventPermission: 'Permission',
      eventCwd: 'Working directory',
      lastTextLabel: 'Latest',
      newSessionModel: 'Model',
      sessionCountUnit: 'sessions',
      expandRest: 'Show remaining',
      peerGroups: 'Peer workspaces',
      groupToday: 'Today',
      groupYesterday: 'Yesterday',
      groupEarlier: 'Earlier',
      questionTitle: 'Waiting for your answer',
      questionDetail: 'Show details',
      questionCustom: 'Custom answer (optional)',
      questionSkip: 'Skip this question',
      questionSkipAll: 'Skip all',
      questionSubmit: 'Submit answers',
      questionMissing: 'Unanswered questions',
      questionAnswered: 'Answered',
      questionSkipped: '(skipped)',
      questionCancelledHint: 'Changes requested; waiting for the peer.',
      questionExpired: 'The question expired and was handed back to the local UI.',
      questionBadAnswer: 'Invalid answer',
      planReviewTitle: 'Plan awaiting review',
      planViewFull: 'View full plan',
      planCollapse: 'Collapse plan',
      planRequestChanges: 'Request changes',
      planApprove: 'Approve & run',
      // Chunked file transfer (0.9.0).
      uploadsReceive: 'Accept files pushed by paired peers',
      uploadsReceiveOn: 'On — paired peers can push files to this device',
      uploadsReceiveOff: 'Off — peers cannot push files',
      uploadsDirHint: 'Saved to',
      uploadsTitle: 'Push a file to the peer',
      uploadsDesc: 'Chunked transfer with sha256 verification; the peer stores it under shadow-uploads',
      uploadsFile: 'Selected file',
      uploadsSend: 'Push file to peer',
      uploadsProgress: 'pushed',
      uploadsDone: 'Delivered',
      uploadsFailed: 'Push failed',
      uploadsNoFile: 'Choose a file first',
      uploadsReceiveOffPeer: 'The peer does not accept files',
      uploadsHash: 'sha256',
      uploadsBytes: 'Size',
      pluginVersion: 'Shadow plugin',
      peerVersion: 'Peer',
      latestEvents: 'Recent events',
      noReplyNeeded: 'Submitted; waiting for the peer to continue.',
      statusRunning: 'Running',
      statusWaiting: 'Waiting for approval',
      statusDone: 'Done',
      statusFailed: 'Failed',
      statusStopped: 'Stopped',
      statusIdle: 'Idle',
      statusDisconnected: 'Disconnected',
      statusLost: 'Session lost',
      approve: 'Allow once',
      reject: 'Reject',
      toolCall: 'Tool call',
      toolResult: 'Tool result',
      approvals: 'Pending approvals',
      loading: 'Loading…',
      inputPlaceholder: 'Message or create a task, / for commands, @ for files',
      permFull: 'Full access',
      permWorkspace: 'Workspace Write',
      permReadonly: 'Read Only',
      // Shadow composer controls (0.10.25): permission presets, attachments, voice.
      permAuto: 'Auto review',
      permCustom: 'Custom',
      permMenuTitle: 'Access mode',
      permSwitching: 'Switching…',
      permSwitchFailed: 'Failed to switch permission',
      permRiskTitle: 'Switch to “{name}”?',
      permRiskBody: 'This preset lets the peer session run commands or edit files without a per-call approval. Confirm that you understand the risk.',
      permRiskAck: 'I understand the risk and want to continue',
      permRiskConfirm: 'Switch',
      permRiskCancel: 'Cancel',
      addMenuAdd: 'Add',
      addMenuFile: 'Photos or files…',
      addMenuPush: 'Push a file to the peer…',
      attachUploading: 'Uploading',
      attachReady: 'Ready',
      attachFailed: 'Upload failed',
      attachTooLarge: 'File is too large',
      attachTooMany: 'Too many attachments',
      attachRemove: 'Remove attachment',
      attachRetryHint: 'An attachment failed to upload — remove it and retry.',
      attachSending: 'Sending…',
      voiceRequesting: 'Allow microphone access…',
      voiceRecording: 'Recording',
      voiceTranscribing: 'Transcribing…',
      voiceCancel: 'Cancel',
      voiceStop: 'Stop',
      voiceEmpty: 'No speech detected',
      voiceFailed: 'Speech transcription failed: ',
      voiceDenied: 'Microphone access is blocked. Allow it in the browser and system settings.',
      voiceNoDevice: 'Microphone unavailable. Check the input device.',
      voiceUnsupported: 'This browser cannot record audio.',
      voiceUnavailable: 'Voice input is not enabled on this machine (no speechToText service).',
      voiceUnprepared: 'Speech recognition is not ready. Use “Download & prepare”, then record again.',
      voicePreparing: 'Preparing the model…',
      voicePrepare: 'Download & prepare',
      voiceReady: 'Voice input',
      voiceInterrupted: 'Recording was interrupted. Try again.',
      toolQuestion: 'Question',
      questionWaiting: 'Waiting for answer',
      questionReview: 'View answer',
      questionUnanswered: 'Unanswered',
      emptyText: '(no text output)',
      reconnect: 'Reconnect',
      retry: 'Retry',
      refresh: 'Refresh',
      groupSuffix: ' workspaces',
      debugLog: 'Debug log',
      truncated: '(truncated)',
      auditAt: 'Time',
      auditOp: 'Operation',
      auditResult: 'Result',
      workspaceCount: 'sessions',
      unknownError: 'unknown error',
      displayGroups: 'Peer workspaces',
      sharingNow: 'sharing',
      notSharing: 'not sharing',
      refreshFailed: 'refresh failed',
      connectHint: 'The sharing computer must enable "Share local workspaces" and tick a workspace.',
    }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      const style = existing || document.createElement('style')
      if (!existing) {
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = `
.sdw-page{box-sizing:border-box;height:100%;overflow:hidden;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base)}
.sdw-head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.sdw-back{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:4px 8px;border-radius:var(--dsw-radius-md,8px);white-space:nowrap}
.sdw-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdw-head-main{min-width:0;flex:1}
.sdw-title{margin:0;font-size:15px;font-weight:600;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.sdw-dot.on{background:var(--dsw-alias-state-success-primary,#22c55e)}
.sdw-dot.run{background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-dot.warn{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.sdw-dot.err{background:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-body{flex:1;min-height:0;display:flex;overflow:hidden}
.sdw-scroll{flex:1;min-height:0;overflow:auto;padding:18px 22px 28px}
.sdw-settings{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.sdw-tabs{display:flex;gap:6px;border-bottom:.5px solid var(--dsw-alias-border-l1);margin-bottom:2px}
.sdw-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;border-radius:8px 8px 0 0}
.sdw-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.sdw-card-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.sdw-card-title{font-size:13.5px;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-card-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 16px 10px}
.sdw-row{display:flex;align-items:center;gap:12px;min-height:44px;padding:8px 16px;border-top:.5px solid var(--dsw-alias-border-l1);box-sizing:border-box}
.sdw-row:first-child{border-top:0}
.sdw-row-main{flex:1;min-width:0}
.sdw-row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-row-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-row-end{flex:none;display:flex;align-items:center;gap:8px}
.sdw-switch{position:relative;width:38px;height:22px;flex:none;border-radius:11px;border:none;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background .15s ease}
.sdw-switch:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s ease}
.sdw-switch.on{background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-switch.on:after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.sdw-switch:disabled{opacity:.45;cursor:default}
.sdw-check{width:16px;height:16px;margin:0;flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}
.sdw-check:disabled{opacity:.45;cursor:default}
.sdw-btn{box-sizing:border-box;height:30px;padding:0 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.sdw-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:var(--dsw-radius-sm,6px)}
.sdw-btn-muted{color:var(--dsw-alias-label-tertiary)}
.sdw-alias-input{box-sizing:border-box;width:100%;height:26px;padding:2px 8px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}
.sdw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sdw-btn:disabled{opacity:.45;cursor:default}
.sdw-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.sdw-btn.primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.sdw-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:transparent;background:transparent}
.sdw-btn.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}
.sdw-empty{padding:18px 16px;color:var(--dsw-alias-label-tertiary);text-align:center;line-height:22px}
.sdw-error{color:var(--dsw-alias-state-error-primary)}
.sdw-notice{color:var(--dsw-alias-label-tertiary)}
.sdw-audit-row{display:grid;grid-template-columns:150px 120px 1fr;gap:10px;padding:6px 16px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sdw-audit-row:first-child{border-top:0}
.sdw-audit-time{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sdw-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px;overflow-wrap:anywhere}
.sdw-side{width:300px;flex:none;border-right:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;overflow:hidden}
.sdw-side-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;color:var(--dsw-alias-label-secondary);font-size:12px}
.sdw-side-list{flex:1;overflow:auto;padding:0 8px 12px}
.sdw-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 10px;margin:2px 0;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.sdw-item:hover,.sdw-item.active{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-item-main{min-width:0;flex:1}
.sdw-item-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-item-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.sdw-chat{flex:1;overflow:auto;padding:18px 22px 8px;display:flex;flex-direction:column;gap:12px}
.sdw-bubble{max-width:min(720px,86%);border-radius:14px;padding:10px 14px;box-sizing:border-box;overflow-wrap:anywhere;white-space:pre-wrap}
.sdw-bubble.user{align-self:flex-end;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2)}
.sdw-bubble.assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);white-space:normal}
.sdw-bubble.assistant p{margin:0 0 8px}
.sdw-bubble.assistant p:last-child{margin-bottom:0}
.sdw-bubble.assistant pre{margin:8px 0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:1.55;white-space:pre}
.sdw-bubble.assistant code{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;background:var(--dsw-alias-bg-layer-3);border-radius:4px;padding:1px 4px}
.sdw-bubble.assistant h3,.sdw-bubble.assistant h4,.sdw-bubble.assistant h5{margin:10px 0 6px;font-size:13.5px}
.sdw-bubble.assistant h1,.sdw-bubble.assistant h2{margin:12px 0 6px;font-size:15px}
.sdw-bubble.assistant h6{margin:10px 0 6px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.sdw-bubble.assistant ul,.sdw-bubble.assistant ol{margin:4px 0 8px;padding-left:20px}
.sdw-bubble.assistant li{margin:2px 0}
.sdw-bubble.assistant blockquote{margin:8px 0;padding:2px 10px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.sdw-bubble.assistant hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}
.sdw-bubble.assistant a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.sdw-bubble.assistant a:hover{text-decoration:underline}
.sdw-table-wrap{max-width:100%;overflow:auto;margin:8px 0}
.sdw-table{border-collapse:collapse;font-size:12.5px;min-width:50%}
.sdw-table th,.sdw-table td{border:.5px solid var(--dsw-alias-border-l3);padding:4px 8px;text-align:left;vertical-align:top}
.sdw-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.sdw-code{position:relative}
.sdw-code-lang{position:absolute;top:4px;right:8px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.sdw-think{align-self:flex-start;max-width:min(720px,86%);box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.sdw-think summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;list-style:none}
.sdw-think summary::-webkit-details-marker{display:none}
.sdw-think summary::before{content:'▸ ';display:inline-block;transition:transform .15s}
.sdw-think[open] summary::before{transform:rotate(90deg)}
.sdw-think-body{margin-top:6px;max-height:280px;overflow:auto}
.sdw-think-body p{margin:0 0 6px}
.sdw-think-body p:last-child{margin-bottom:0}
.sdw-bubble.assistant ul,.sdw-bubble.assistant ol{margin:6px 0;padding-left:20px}
.sdw-stream{align-self:flex-start;max-width:min(720px,86%);color:var(--dsw-alias-label-secondary);font-size:12.5px;display:flex;align-items:center;gap:8px}
.sdw-spinner{width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sdw-spin .7s linear infinite;flex:none}
@keyframes sdw-spin{to{transform:rotate(360deg)}}
.sdw-tool{align-self:stretch;max-width:min(760px,100%);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sdw-tool-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.sdw-tool-name{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);color:var(--dsw-alias-label-primary)}
.sdw-tool-body{margin:0;padding:8px 12px 10px;border-top:.5px solid var(--dsw-alias-border-l1);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow:auto;max-height:260px;color:var(--dsw-alias-label-secondary)}
.sdw-approval{align-self:stretch;max-width:min(760px,100%);border:.5px solid var(--dsw-alias-state-warning-primary,#f59e0b);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.sdw-approval-head{display:flex;align-items:center;gap:8px;font-weight:600}
.sdw-approval-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.sdw-actions{display:flex;gap:8px;justify-content:flex-end}
.sdw-composer{flex:none;border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 18px 14px;display:flex;flex-direction:column;gap:8px}
.sdw-input{box-sizing:border-box;width:100%;min-height:56px;max-height:200px;resize:vertical;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.sdw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sdw-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0;border-color:transparent}
.sdw-composer-bar{display:flex;align-items:center;gap:10px;justify-content:flex-end}
.sdw-hint{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-banner{flex:none;display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
/* --- transcript: native-looking tool / command / todo / job cards --- */
.sdw-tool-head{user-select:none}
.sdw-tool-kind{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:18px;white-space:nowrap}
.sdw-tool-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.sdw-tool-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap}
.sdw-tool-toggle{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sdw-tool-error{border-color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-tool-error .sdw-tool-name{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-tool-sections{border-top:.5px solid var(--dsw-alias-border-l1)}
.sdw-tool-section{padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l1)}
.sdw-tool-section:first-child{border-top:0}
.sdw-tool-label{font-size:10.5px;line-height:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.sdw-tool-pre{margin:0;white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:240px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.sdw-diff-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.sdw-diff-added{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdw-diff-removed{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-diff{max-height:240px;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:4px 0}
.sdw-diff-line{display:flex;gap:8px;padding:0 10px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.sdw-diff-sign{flex:none;width:8px;color:var(--dsw-alias-label-tertiary)}
.sdw-diff-line.add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);color:var(--dsw-alias-label-primary)}
.sdw-diff-line.del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);color:var(--dsw-alias-label-primary)}
.sdw-diff-line.ctx{color:var(--dsw-alias-label-tertiary)}
.sdw-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:min(760px,100%)}
.sdw-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%}
.sdw-chip-label{color:var(--dsw-alias-label-tertiary)}
.sdw-chip-value{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.sdw-eventline{align-self:center;max-width:min(760px,100%);color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px;text-align:center}
.sdw-command{align-self:stretch;max-width:min(760px,100%);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sdw-command-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.sdw-command-prompt{color:var(--dsw-alias-state-success-primary,#22c55e);font-weight:600}
.sdw-command-name{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.sdw-command-args{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:2;min-width:0}
.sdw-command-error .sdw-command-name{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-todo{align-self:stretch;max-width:min(760px,100%);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sdw-todo-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sdw-todo-title{flex:1;font-weight:500;color:var(--dsw-alias-label-primary)}
.sdw-todo-list{padding:2px 12px 10px;display:flex;flex-direction:column;gap:4px}
.sdw-todo-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sdw-todo-mark{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.sdw-todo-item.done .sdw-todo-mark{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdw-todo-item.active .sdw-todo-mark{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-todo-item.done .sdw-todo-text{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.sdw-todo-item.active .sdw-todo-text{color:var(--dsw-alias-label-primary);font-weight:500}
.sdw-job{align-self:stretch;max-width:min(760px,100%);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.sdw-job-head{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.sdw-job-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-job-kind{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.sdw-think-sum{color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:11.5px}
.sdw-select{box-sizing:border-box;height:28px;max-width:220px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.sdw-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}
.sdw-head-actions{flex:none;display:flex;align-items:center;gap:8px;min-width:0}
.sdw-model-error{align-self:flex-start;max-width:min(760px,100%);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.sdw-item{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;margin:2px 0;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;box-sizing:border-box;width:100%;text-align:left}
.sdw-item-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.sdw-item-head{display:flex;align-items:center;gap:8px;min-width:0}
.sdw-item-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-item-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.sdw-item-preview{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-item .sdw-dot{margin-top:6px}
.sdw-session-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.sdw-session-bar-label{color:var(--dsw-alias-label-tertiary);font-size:12px}
.sdw-session-bar-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
/* --- interactive user questions / plan review (0.8.0) --- */
.sdw-question{box-sizing:border-box;border:.5px solid var(--dsw-alias-state-warning-primary,#f59e0b);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px;display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto}
.sdw-question-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sdw-question-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-question-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sdw-question-body{display:flex;flex-direction:column;gap:10px}
.sdw-question-item{display:flex;flex-direction:column;gap:6px}
.sdw-question-q{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.sdw-question-detail summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}
.sdw-question-detail>div{margin-top:4px;max-height:180px;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:12px}
.sdw-question-options{display:flex;flex-direction:column;gap:4px}
.sdw-question-option{box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.sdw-question-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sdw-question-option.active{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-3)}
.sdw-question-option:disabled{opacity:.55;cursor:default}
.sdw-question-mark{flex:none;width:14px;color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-question-option-label{font-size:12.5px;line-height:18px}
.sdw-question-option-desc{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;margin-top:1px}
.sdw-question-input{box-sizing:border-box;width:100%;min-height:34px;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.sdw-question-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sdw-question-skip{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;cursor:pointer}
.sdw-question-skip input{margin:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdw-question-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:17px}
.sdw-question-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.sdw-question-done{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.sdw-question-done .sdw-question-head{font-weight:500;color:var(--dsw-alias-label-secondary)}
.sdw-question-answer{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sdw-question-answer-label{color:var(--dsw-alias-label-tertiary)}
/* plan review */
.sdw-plan-review{padding:0;gap:0}
.sdw-plan-strip{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.sdw-plan-strip-title{flex:1;min-width:0;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-plan-link{border:none;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11.5px;cursor:pointer;padding:2px 4px}
.sdw-plan-body{padding:10px 14px;display:flex;flex-direction:column;gap:6px}
.sdw-plan-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.sdw-plan-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sdw-plan-detail{max-height:240px;overflow:auto;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sdw-plan-review .sdw-question-actions{padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l1)}
/* --- chunked file transfer (0.9.0) --- */
.sdw-file{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:260px}
.sdw-file::file-selector-button{font:inherit;font-size:12px;margin-right:8px;padding:4px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.sdw-upload-row{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.sdw-upload-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sdw-upload-meta{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
.sdw-upload-progress{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;min-width:140px;flex:1}
.sdw-upload-progress>span{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .2s}
.sdw-upload-ok{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdw-upload-fail{color:var(--dsw-alias-state-error-primary,#ef4444)}
/* --- native-like shadow chat (0.10.0) ------------------------------------
   Mirrors @deepseek-ai/dsh-client-ui-chat + ui-tool anatomy with theme tokens
   only: 748px content column, 6px flow gap (12px after a reply, 16px after a
   process group), 24px disclosure rows, 13px secondary text, tertiary label. */
.sdc-chat{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.sdc-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px clamp(16px,3vw,24px) 8px;scrollbar-width:thin}
.sdc-col{width:100%;max-width:748px;margin:0 auto;display:flex;flex-direction:column}
.sdc-flow{display:flex;flex-direction:column;min-width:0}
.sdc-flow>*{min-width:0}
.sdc-flow>:not(:first-child){margin-top:6px}
.sdc-flow>:is([data-kind=user],[data-kind=response])+:not([data-kind=user]){margin-top:12px}
.sdc-flow>:is([data-kind=process],[data-kind=turn-tail])+:not([data-kind=user]):not([data-kind=turn-tail]){margin-top:16px}
.sdc-turn{display:flex;flex-direction:column;min-width:0}
.sdc-turn>*+*{margin-top:6px}
.sdc-turn>[data-kind=user]+*{margin-top:14px}
.sdc-turn>[data-kind=response]+*{margin-top:12px}
.sdc-turn>[data-kind=process]:has(+[data-kind=response]){margin-bottom:12px}
/* user row */
.sdc-user{display:flex;flex-direction:column;align-items:flex-end;gap:6px;padding-top:8px}
.sdc-user-stack{min-width:0;max-width:min(calc(748px * .702),82%);display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.sdc-bubble{box-sizing:border-box;max-width:100%;background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-xl,16px);padding:10px 16px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.sdc-user-meta{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-height:16px;padding-right:2px}
/* disclosure rows (process group head, reasoning, tools) */
.sdc-row{box-sizing:border-box;display:flex;align-items:center;width:100%;min-width:0;height:24px;padding:0;border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:24px;text-align:left;cursor:pointer;transition:color .1s ease}
.sdc-row:hover{color:var(--dsw-alias-label-secondary)}
.sdc-row[disabled]{cursor:default}
.sdc-lead{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;margin-right:6px;color:inherit}
.sdc-lead svg{width:14px;height:14px}
.sdc-title{flex:none;font-size:13px;line-height:24px;color:inherit;font-weight:400}
.sdc-sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption);margin:0 8px}
.sdc-sum{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:24px;color:inherit}
.sdc-sum-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px}
.sdc-suffix{flex:none;margin-left:4px;font-size:13px;line-height:24px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.sdc-suffix-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;margin-left:8px}
.sdc-suffix-add{color:var(--dsw-alias-label-tertiary)}
.sdc-row:hover .sdc-suffix-add,.sdc-row[aria-expanded=true] .sdc-suffix-add{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdc-suffix-del{color:var(--dsw-alias-label-tertiary)}
.sdc-row:hover .sdc-suffix-del,.sdc-row[aria-expanded=true] .sdc-suffix-del{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-chevron{flex:none;width:14px;height:14px;margin-left:4px;color:var(--dsw-alias-label-tertiary);opacity:0;transition:transform .12s,opacity .12s}
.sdc-row:hover .sdc-chevron,.sdc-row:focus-visible .sdc-chevron,.sdc-row[aria-expanded=true] .sdc-chevron{opacity:.9}
.sdc-row[aria-expanded=true] .sdc-chevron{transform:rotate(180deg)}
.sdc-rowbody{display:flex;flex-direction:column;min-width:0}
/* reasoning row + body */
.sdc-reason{display:flex;flex-direction:column;min-width:0}
.sdc-reason-body{padding:2px 0 6px calc(22px);max-height:320px;overflow:auto;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.sdc-reason-body .sdc-md{font-size:13px;line-height:20px;color:inherit}
.sdc-reason-body .sdc-md :is(p,ul,ol,blockquote){margin:6px 0}
.sdc-reason-body .sdc-md>:first-child{margin-top:0}
.sdc-reason-body .sdc-md>:last-child{margin-bottom:0}
.sdc-reason-stream{max-height:220px}
/* process group */
.sdc-process{display:flex;flex-direction:column;min-width:0}
.sdc-process-body{display:flex;flex-direction:column;gap:6px;padding:2px 0 2px}
.sdc-process-head{height:auto;min-height:33px;padding:0 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sdc-process[data-open] .sdc-process-head{padding-bottom:8px}
.sdc-process-body{padding-top:6px}
/* running shimmer row */
.sdc-running{display:flex;align-items:center;gap:6px;height:24px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:22px}
.sdc-running-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;animation:sdc-pulse 1.6s ease-in-out infinite}
@keyframes sdc-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.sdc-spin{flex:none;width:13px;height:13px;color:var(--dsw-alias-label-tertiary)}
.sdc-spin-track{fill:none;stroke:currentColor;stroke-width:2;opacity:.25}
.sdc-spin-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-dasharray:12 150;transform-origin:center;animation:sdc-spin-dash 1.5s ease-in-out infinite}
.sdc-spin-ring{transform-origin:center;animation:sdc-spin-rotate 1.5s linear infinite}
@keyframes sdc-spin-rotate{to{transform:rotate(360deg)}}
@keyframes sdc-spin-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.sdc-spin-ring,.sdc-spin-arc,.sdc-running-text{animation:none}.sdc-spin-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
/* tool detail cards */
.sdc-detail{display:flex;flex-direction:column;margin:4px 0 6px 4px;min-width:0}
.sdc-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));overflow:hidden;min-width:0}
.sdc-card-head{display:flex;align-items:center;gap:12px;padding:9px 14px;background:var(--dsw-alias-markdown-code-block-banner,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.sdc-card-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;line-height:18px}
.sdc-card-lang{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace)}
.sdc-card-status{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.sdc-card-status[data-error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-iconbtn{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sdc-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdc-iconbtn svg{width:14px;height:14px}
.sdc-card-body{padding:12px 14px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:224px;overflow:auto}
.sdc-card-body[data-error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-code-pre{margin:0;padding:14px 16px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre;overflow:auto;max-height:320px}
/* edit diff */
.sdc-diff{display:grid;grid-template-columns:minmax(max-content,1fr);padding:6px 0 10px;overflow:auto;max-height:320px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px}
.sdc-diff-line{box-sizing:border-box;display:flex;gap:12px;padding:0 14px;white-space:pre;min-height:20px;color:var(--dsw-alias-label-secondary)}
.sdc-diff-gutter{flex:none;min-width:2.5em;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}
.sdc-diff-sign{flex:none;width:1ch;color:inherit;opacity:.85}
.sdc-diff-text{min-width:0;flex:1}
.sdc-diff-line[data-kind=add]{color:var(--dsw-alias-state-success-primary,#22c55e);background:var(--dsw-alias-code-diff-added,color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary,#22c55e)}
.sdc-diff-line[data-kind=del]{color:var(--dsw-alias-state-error-primary,#ef4444);background:var(--dsw-alias-code-diff-deleted,color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent));box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-diff-line[data-kind=ctx]{color:var(--dsw-alias-label-secondary)}
.sdc-diff-more{display:block;width:100%;padding:4px 14px;border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.sdc-diff-more:hover{color:var(--dsw-alias-label-secondary)}
/* terminal */
.sdc-term{display:flex;flex-direction:column;min-width:0}
.sdc-term-head{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary)}
.sdc-term-prompt{flex:none;color:var(--dsw-alias-label-tertiary)}
.sdc-term-cmd{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sdc-term-out{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:224px;overflow:auto}
.sdc-exit{display:inline-flex;align-items:center;gap:5px;margin-left:8px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.sdc-exit-dot{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#ef4444)}
/* todo checklist */
.sdc-todo{display:flex;flex-direction:column;gap:4px;padding:10px 14px 12px}
.sdc-todo-item{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sdc-todo-mark{flex:none;width:14px;display:inline-flex;justify-content:center;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.sdc-todo-mark svg{width:12px;height:12px}
.sdc-todo-item[data-state=done] .sdc-todo-mark{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdc-todo-item[data-state=active] .sdc-todo-mark{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdc-todo-item[data-state=active] .sdc-todo-text{color:var(--dsw-alias-label-primary)}
.sdc-todo-item[data-state=done] .sdc-todo-text{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.sdc-todo-text{min-width:0;overflow-wrap:anywhere}
/* job card */
.sdc-job{display:flex;flex-direction:column}
.sdc-job-meta{display:grid;grid-template-columns:5.5em minmax(0,1fr);gap:12px;padding:6px 14px 10px;font-size:12px;line-height:18px}
.sdc-job-meta dt{color:var(--dsw-alias-label-caption)}
.sdc-job-meta dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap}
/* generic arg/result IO */
.sdc-io{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:14px;align-items:baseline;padding:10px 14px;max-height:150px;overflow:auto}
.sdc-io+.sdc-io{border-top:.5px solid var(--dsw-alias-border-l2)}
.sdc-io-label{position:sticky;top:0;color:var(--dsw-alias-label-caption)}
.sdc-io-text{min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.sdc-io-text[data-error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
/* assistant markdown */
.sdc-response{min-width:0;font-size:14px;line-height:24px;color:var(--dsw-alias-label-primary)}
.sdc-md{min-width:0;overflow-wrap:break-word;word-break:break-word}
.sdc-md>:first-child{margin-top:0!important}
.sdc-md>:last-child{margin-bottom:0!important}
.sdc-md p{margin:16px 0}
.sdc-md h1,.sdc-md h2,.sdc-md h3{margin:32px 0 16px;font-weight:600;line-height:1.35}
.sdc-md h1{font-size:24px}
.sdc-md h2{font-size:20px}
.sdc-md h3{font-size:17px}
.sdc-md h4,.sdc-md h5,.sdc-md h6{margin:16px 0;font-size:15px;font-weight:600}
.sdc-md strong{font-weight:600}
.sdc-md ul,.sdc-md ol{margin:16px 0;padding-left:18px}
.sdc-md li+li{margin-top:6px}
.sdc-md li::marker{color:var(--dsw-alias-label-secondary)}
.sdc-md li>p{margin:8px 0}
.sdc-md li>:first-child{margin-top:0}
.sdc-md li>:last-child{margin-bottom:0}
.sdc-md blockquote{margin:16px 0;padding-left:14px;border-left:2px solid var(--dsw-alias-label-caption);color:var(--dsw-alias-label-secondary)}
.sdc-md hr{height:.5px;margin:32px 0;border:none;background:var(--dsw-alias-border-l2)}
.sdc-md a{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));font-weight:500;text-decoration:none}
.sdc-md a:hover{text-decoration:underline dotted var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-underline-offset:3px}
.sdc-md :not(pre)>code{box-sizing:border-box;display:inline-flex;align-items:center;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:.875em;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-bg-layer-3));border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:0 5px;line-height:1.6;vertical-align:baseline}
.sdc-table-wrap{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;margin:16px 0;border-radius:var(--dsw-radius-sm,6px)}
.sdc-table-wrap:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.sdc-table{border-collapse:collapse;width:max-content;max-width:max-content;font-size:13px;line-height:20px}
.sdc-table th{text-align:start;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-weight:600;color:var(--dsw-alias-label-primary);min-width:100px;max-width:min(30vw,320px)}
.sdc-table td{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);min-width:100px;max-width:min(30vw,320px)}
.sdc-table th:first-child,.sdc-table td:first-child{padding-left:0}
.sdc-table td:last-child{padding-right:0}
.sdc-table code{font-size:11px}
/* code fence block */
.sdc-codeblock{position:relative;margin:16px 0;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-lg,12px);overflow:hidden;border:.5px solid var(--dsw-alias-border-l1)}
.sdc-codebanner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;background:var(--dsw-alias-markdown-code-block-banner,var(--dsw-alias-bg-layer-3));font-size:11px;line-height:18px;position:sticky;top:0;z-index:2}
.sdc-codelang{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;line-height:18px}
.sdc-codecopy{flex:none;display:inline-flex;align-items:center;gap:4px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer}
.sdc-codecopy:hover{color:var(--dsw-alias-label-primary)}
.sdc-codecopy svg{width:13px;height:13px}
.sdc-codeblock>pre{margin:0;padding:14px 16px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;line-height:20px;white-space:pre;color:var(--dsw-alias-label-primary)}
.sdc-codeblock>pre code{font:inherit;background:none;border:none;padding:0}
.sdc-md-compact{font-size:13px;line-height:22px}
.sdc-md-compact :is(p,ul,ol,blockquote){margin:8px 0}
.sdc-md-compact li+li{margin-top:3px}
.sdc-md-compact :is(h1,h2,h3,h4,h5,h6){margin:12px 0 8px;font-size:15px;line-height:1.4}
.sdc-md-compact .sdc-codeblock{margin:10px 0}
/* streaming caret */
.sdc-caret{display:inline-block;width:7px;height:1.05em;margin-left:2px;vertical-align:text-bottom;background:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));border-radius:1px;animation:sdc-blink 1s step-end infinite}
@keyframes sdc-blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.sdc-caret{animation:none}}
/* turn tail (time + actions) */
.sdc-tail{display:flex;align-items:center;gap:8px;min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.sdc-tail-meta{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdc-tail-actions{flex:none;display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .12s}
.sdc-turn:hover .sdc-tail-actions,.sdc-tail:focus-within .sdc-tail-actions,.sdc-tail[data-latest] .sdc-tail-actions{opacity:1}
.sdc-act{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm,6px);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.sdc-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sdc-act svg{width:15px;height:15px}
.sdc-act[data-copied]{color:var(--dsw-alias-state-success-primary,#22c55e)}
/* composer */
.sdc-composer-wrap{flex:none;display:flex;justify-content:center;padding:8px clamp(16px,3vw,24px) 12px}
.sdc-composer-inner{width:100%;max-width:748px;display:flex;flex-direction:column;gap:6px}
.sdc-composer{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));border:.5px solid var(--dsw-alias-border-l2);border-radius:22px;box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.04));padding:10px 10px 8px 16px;transition:border-color .12s}
.sdc-composer:focus-within{border-color:var(--dsw-alias-border-l3)}
.sdc-inputrow{display:flex;align-items:flex-end;gap:8px;min-width:0}
.sdc-input{box-sizing:border-box;flex:1 1 auto;width:100%;min-height:28px;max-height:200px;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:24px;padding:4px 6px 4px 0;caret-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdc-input::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.sdc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.sdc-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:2px 4px 2px 0;flex-wrap:wrap}
.sdc-bar-left{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.sdc-bar-right{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.sdc-select{box-sizing:border-box;max-width:200px;height:28px;padding:0 20px 0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 4px center;background-repeat:no-repeat;background-size:12px 12px;appearance:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
.sdc-select:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}
.sdc-select:disabled{opacity:.5;cursor:default}
.sdc-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}
.sdc-hint{min-width:0;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdc-perm{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;border-radius:var(--dsw-radius-sm,6px)}
.sdc-perm svg{width:15px;height:15px;flex:none;color:var(--dsw-alias-label-tertiary)}
.sdc-send{flex:none;width:32px;height:32px;border-radius:999px;border:none;display:grid;place-items:center;padding:0;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));color:#fff;cursor:pointer;transition:background-color .1s}
.sdc-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary))}
.sdc-send:disabled{opacity:.4;cursor:default}
.sdc-send svg{width:16px;height:16px}
.sdc-stop{flex:none;width:32px;height:32px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);display:grid;place-items:center;padding:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.sdc-stop:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdc-stop svg{width:13px;height:13px}
.sdc-reconnect{display:flex;align-items:center;gap:8px;margin:0 auto 2px;width:100%;max-width:748px;box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-warn-primary,#f59e0b);font-size:12px;line-height:18px;padding:5px 10px}
.sdc-reconnect-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-reconnect .sdc-link{flex:none;margin-left:auto;border:none;background:none;color:inherit;font:inherit;font-size:12px;text-decoration:underline dotted;cursor:pointer;padding:0}
.sdc-toBottom{position:absolute;left:50%;bottom:14px;transform:translateX(calc(-50% + 320px));z-index:6;width:34px;height:34px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel,0 4px 12px rgba(0,0,0,.12));display:grid;place-items:center;cursor:pointer;padding:0}
.sdc-toBottom:hover{background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-layer-3))}
.sdc-toBottom svg{width:16px;height:16px}
/* loading skeleton + empty state */
.sdc-skeleton{display:flex;flex-direction:column;gap:14px;padding-top:8px}
.sdc-sk-row{display:flex;align-items:center;gap:10px}
.sdc-sk-bar{height:12px;border-radius:6px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-3));position:relative;overflow:hidden}
.sdc-sk-bar:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--dsw-alias-bg-layer-1),transparent);transform:translateX(-100%);animation:sdc-sk 1.4s ease-in-out infinite}
@keyframes sdc-sk{to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.sdc-sk-bar:after{animation:none}}
.sdc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:72px 16px 40px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.sdc-empty-icon{width:40px;height:40px;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));opacity:.7}
.sdc-empty-title{font-size:15px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.sdc-empty-hint{font-size:12px;line-height:18px;max-width:340px}
/* native-like shadow session list */
.sdw-sessions{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.sdw-sessions-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.sdw-sessions-title{font-size:13.5px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sdw-sessions-count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sdw-icon-btn{margin-left:auto;width:28px;height:28px;flex:none;display:grid;place-items:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.sdw-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-icon-btn svg{width:15px;height:15px}
.sdw-session-group{display:flex;flex-direction:column}
.sdw-session-group-label{padding:10px 14px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500}
.sdw-session-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 14px;border:none;border-top:.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;cursor:pointer}
.sdw-session-group .sdw-session-row:first-of-type{border-top:0}
.sdw-session-row:hover,.sdw-session-row.active{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-session-row .sdw-dot{flex:none}
.sdw-session-row-spacer{width:6px;flex:none}
.sdw-session-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.sdw-session-row-title{color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-session-row-preview{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdw-session-row-side{flex:none;display:flex;align-items:center;gap:8px}
.sdw-session-row-time{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;white-space:nowrap}
.sdw-session-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-warning-tertiary,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-warning-primary,#f59e0b);font-size:10.5px;line-height:16px;font-weight:600}

/* Shadow launcher: a native-looking replica of the DSH workspace list. The
   row/header classes come from the live build (discovered at runtime); only the
   host container, menu surface and fallback shims are styled here. The host is
   rendered inside the native sidebar.workspaces slot, so it participates in
   the sidebar flow instead of covering the native workspace list on small
   windows; .sdw-launch-fixed is only the fallback when that slot is missing. */
.sdw-launch-host{display:flex;flex-direction:column;min-height:0;overflow:hidden;pointer-events:auto;background:transparent;color:#fff;width:100%;max-height:min(42vh,400px);margin-top:6px}
.sdw-launch-host,.sdw-launch-host *{color:#fff}
.sdw-launch-host [class*="sectionLabel"]{color:var(--dsw-alias-label-tertiary,#8b9096)}
.sdw-launch-host [class*="sectionOverflowButton"]{color:var(--dsw-alias-label-tertiary,#8b9096)}
.sdw-launch-host.sdw-launch-fixed{position:fixed;left:8px;top:auto;bottom:56px;width:264px;z-index:2147483000}
.sdw-launch-flow{position:static;left:auto;top:auto;bottom:auto;width:100%;flex:0 0 auto;max-height:none;margin:8px 0 4px;z-index:auto}
.sdw-launch-flow .sdw-launch-scroll{overflow:visible;flex:0 0 auto;min-height:0;padding-bottom:0;scrollbar-gutter:auto}
.sdw-launch-scroll{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding-bottom:16px;scrollbar-gutter:stable}
.sdw-launch-scroll::-webkit-scrollbar{width:5px;background:transparent}
.sdw-launch-scroll::-webkit-scrollbar-track{background:transparent}
.sdw-launch-scroll::-webkit-scrollbar-thumb{border-radius:3px;background:transparent}
.sdw-launch-host:hover .sdw-launch-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,#4a4a52)}
.sdw-launch-host:hover .sdw-launch-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,#5a5a64)}
.sdw-launch-status{display:inline-block;flex:none;width:6px;height:6px;margin-left:2px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-launch-menu{position:fixed;z-index:2147483001;display:flex;flex-direction:column;min-width:112px;padding:4px;border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#232325));box-shadow:0 8px 24px #00000040;backdrop-filter:blur(16px)}
.sdw-launch-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,#e8e8ea);font:inherit;font-size:13px;line-height:20px;text-align:left;white-space:nowrap;cursor:pointer}
.sdw-launch-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#2b2b30)}
.sdw-launch-toast{position:fixed;left:50%;bottom:132px;transform:translateX(-50%);z-index:2147483002;padding:6px 12px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg,#353638);color:var(--dsw-alias-toast-label,#fff);font-size:13px;line-height:20px;box-shadow:0 6px 20px #00000040;pointer-events:none}
.sdw-launch-hover{position:fixed;z-index:2147483001;display:flex;flex-direction:column;gap:8px;max-width:280px;padding:10px 12px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-tooltip-bg,#353638);color:#fff;box-shadow:0 10px 28px #00000059;pointer-events:none}
.sdw-launch-hover-title{font-size:14px;line-height:20px;color:#fff;overflow-wrap:break-word}
.sdw-launch-hover-path,.sdw-launch-hover-time{font-size:12px;line-height:16px;color:#cfd3d6;word-break:break-all}
.sdw-launch-hover-status{font-size:12px;line-height:20px;color:#adb2b8}
/* Fallback shims: only used when the live build's hashed class names cannot be
   discovered (e.g. a future DSH build changes the CSS-module naming scheme). */
.sdw-fb-projectRow,.sdw-fb-sessionRow{box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-primary,#e8e8ea);cursor:pointer;user-select:none}
.sdw-fb-projectRow{height:34px}
.sdw-fb-sessionRow{height:32px;gap:0}
.sdw-fb-projectRow:hover,.sdw-fb-sessionRow:hover,.sdw-fb-sessionRow.sdw-fb-selected{background:var(--dsw-alias-interactive-bg-hover,#2b2b30)}
.sdw-fb-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.sdw-fb-projectRow .sdw-fb-chevron{display:none}
.sdw-fb-projectRow:hover .sdw-fb-chevron{display:inline-flex}
.sdw-fb-projectRow:hover .sdw-fb-folder{display:none}
.sdw-fb-projectRow.sdw-fb-menuOpen,.sdw-fb-sessionRow.sdw-fb-menuOpen{background:var(--dsw-alias-interactive-bg-hover,#2b2b30)}
.sdw-fb-projectText{display:flex;flex-direction:column;flex:1;min-width:0}
.sdw-fb-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.sdw-fb-sessionRow .sdw-fb-title{margin:0 6px 0 4px}
.sdw-fb-rowActions{display:none;flex:none;align-items:center;gap:15px}
.sdw-fb-projectRow:hover .sdw-fb-rowActions,.sdw-fb-sessionRow:hover .sdw-fb-rowActions,.sdw-fb-projectRow.sdw-fb-menuOpen .sdw-fb-rowActions,.sdw-fb-sessionRow.sdw-fb-menuOpen .sdw-fb-rowActions{display:inline-flex}
.sdw-fb-sessionRow:hover .sdw-fb-time{display:none}
.sdw-fb-iconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:none;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a92);cursor:pointer}
.sdw-fb-iconButton:hover{color:var(--dsw-alias-label-primary,#e8e8ea)}
.sdw-fb-arrow{transition:transform .15s var(--ds-ease-in-out,ease)}
.sdw-fb-arrowOpen{transform:rotate(90deg)}
.sdw-fb-time{flex:none;color:var(--dsw-alias-label-tertiary,#8a8a92);font-size:10px;line-height:16px}
.sdw-fb-sectionHeader{box-sizing:border-box;display:flex;align-items:center;gap:4px;flex:none;height:36px;margin-bottom:4px;padding-left:4px;color:var(--dsw-alias-label-tertiary,#8a8a92);overflow:hidden}
.sdw-fb-sectionLabel{min-width:0;max-width:45%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:20px}
.sdw-fb-headerActions{display:flex;align-items:center;gap:4px;flex:none}
.sdw-fb-headerIconButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#b6b6bc);cursor:pointer}
.sdw-fb-headerIconButton:hover{background:var(--dsw-alias-interactive-bg-hover,#2b2b30)}
.sdw-fb-groupSection{position:relative}
.sdw-fb-groupSection+.sdw-fb-groupSection{margin-top:4px}
.sdw-fb-groupSection>*+*{margin-top:2px}
.sdw-fb-sessionOverflowButton{display:block;box-sizing:border-box;width:100%;height:28px;padding:0 12px 0 28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a92);font:inherit;font-size:12px;line-height:24px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.sdw-fb-sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary,#b6b6bc)}
.sdw-fb-empty{color:var(--dsw-alias-label-tertiary,#8a8a92);padding:16px 12px;font-size:13px}
.sdw-fb-dot{position:relative;display:inline-block;flex:none;width:10px;height:10px}
.sdw-fb-dot::after{content:"";position:absolute;inset:20%;border-radius:50%;background:currentColor}
.sdw-fb-dot[data-state=done]{color:var(--dsw-alias-state-success-primary,#22c55e)}
.sdw-fb-dot[data-state=warning]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.sdw-fb-dot[data-state=error]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdw-fb-dot[data-state=idle]{color:var(--dsw-alias-state-idle-primary,#d4d4d4)}
.sdw-fb-spinner{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary,#8a8a92);animation:sdw-fb-spin 1.5s linear infinite}
.sdw-fb-spinnerMotion{transform-origin:center;animation:sdw-fb-spin 1.5s linear infinite}
.sdw-fb-spinnerTrack,.sdw-fb-spinnerArc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.sdw-fb-spinnerTrack{opacity:.25}
.sdw-fb-spinnerArc{stroke-dasharray:12 150;animation:sdw-fb-dash 1.5s ease-in-out infinite}
@keyframes sdw-fb-spin{to{transform:rotate(360deg)}}
@keyframes sdw-fb-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
/* native-like interactive cards above the composer */
.sdc-cards{display:flex;flex-direction:column;gap:8px;margin-bottom:2px;max-height:52vh;overflow-y:auto;overscroll-behavior:contain}
.sdc-attention{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-state-warn-secondary,#f7ad31);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));overflow:hidden}
.sdc-attention-strip{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--dsw-alias-state-warn-tertiary,#fef5e7);color:var(--dsw-alias-state-warn-primary,#f59e0b);font-size:13px;line-height:18px}
.sdc-attention-body{display:flex;flex-direction:column;gap:6px;padding:12px 16px 0;max-height:42vh;overflow-y:auto;font-size:14px;line-height:24px}
.sdc-attention-title{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}
.sdc-attention-command{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:13px;line-height:20px;word-break:break-all;white-space:pre-wrap}
.sdc-attention-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:14px 16px}
.sdc-cardbtn{box-sizing:border-box;height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.sdc-cardbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sdc-cardbtn:disabled{opacity:.45;cursor:default}
.sdc-cardbtn[data-variant=primary]{background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:#fff}
.sdc-cardbtn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-brand-primary));opacity:.95}
.sdc-cardbtn[data-variant=danger]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.sdc-cardbtn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));border-color:transparent}
.sdc-question{display:flex;flex-direction:column;min-width:0}
.sdc-question-item{display:flex;flex-direction:column;gap:6px;padding:4px 0}
.sdc-question-q{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.sdc-question-options{display:flex;flex-direction:column;gap:1px;margin:2px 0 0;padding:2px 0}
.sdc-question-option{box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;width:100%;min-height:36px;padding:7px 10px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.sdc-question-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sdc-question-option[data-active]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.sdc-question-option:disabled{opacity:.6;cursor:default}
.sdc-question-mark{flex:none;width:18px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;margin-top:1px}
.sdc-question-option[data-active] .sdc-question-mark{color:var(--dsw-alias-label-primary)}
.sdc-question-opt{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.sdc-question-label{font-size:14px;line-height:22px;font-weight:500}
.sdc-question-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.sdc-question-input{box-sizing:border-box;width:100%;min-height:36px;max-height:120px;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
.sdc-question-input::placeholder{color:var(--dsw-alias-label-caption)}
.sdc-question-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.sdc-question-detail{margin:0}
.sdc-question-detail summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sdc-question-detail>div{margin-top:4px;max-height:200px;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.sdc-question-skip{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}
.sdc-question-skip input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);margin:0}
.sdc-question-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:4px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l1)}
.sdc-question-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;flex:1;min-width:0}
.sdc-question-done{border-color:var(--dsw-alias-border-l2)}
.sdc-question-done .sdc-attention-strip{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.sdc-answer{display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sdc-answer-q{color:var(--dsw-alias-label-tertiary)}
.sdc-answer-a{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.sdc-plan{display:flex;flex-direction:column;min-width:0}
.sdc-plan-summary{padding:14px 16px 12px;display:flex;flex-direction:column;gap:8px}
.sdc-plan-title{margin:0;font-size:15px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdc-plan-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.sdc-plan-detail{margin:0;padding:12px 16px 0;border-top:.5px solid var(--dsw-alias-border-l1);max-height:260px;overflow:auto;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.sdc-plan-link{border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:0;text-decoration:underline dotted;text-underline-offset:3px}
.sdc-plan-link:hover{color:var(--dsw-alias-label-primary)}
/* running text pulse + chips + error rows */
.sdc-row[data-running] .sdc-title,.sdc-row[data-running] .sdc-sum,.sdc-row[data-running] .sdc-suffix{animation:sdc-pulse 1.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.sdc-row[data-running] .sdc-title,.sdc-row[data-running] .sdc-sum,.sdc-row[data-running] .sdc-suffix{animation:none}}
.sdc-chip-row{display:flex;align-items:center;gap:6px;height:22px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px}
.sdc-chip-label{flex:none;color:var(--dsw-alias-label-caption)}
.sdc-chip-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.sdc-error-row{display:flex;align-items:flex-start;gap:6px;min-height:24px;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:13px;line-height:20px;padding:2px 0}
.sdc-error-row svg{flex:none;width:14px;height:14px;margin-top:3px}
.sdc-error-text{min-width:0;overflow-wrap:anywhere}
/* native chat surface helpers (0.10.19) */
.sdw-launch-host [class*="headerActions"] [class*="iconButton"]{color:var(--dsw-alias-label-secondary,#a9adb3)}
.sdw-launch-host [class*="headerActions"] [class*="iconButton"]:hover{color:var(--dsw-alias-label-primary,#fff)}
.sdw-nc-status{display:inline-flex;align-items:center;gap:6px;margin-left:8px;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.sdw-nc-status-waiting{color:var(--dsw-alias-state-warn-primary);flex:none}
.sdw-nc-attention{display:flex;flex-direction:column;gap:8px;width:100%;max-width:calc(var(--dsh-chat-content-width,748px) + 32px);align-self:center;padding:0 var(--dsh-composer-side-clearance,16px)}
.sdw-nc-banner{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto 8px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.sdw-nc-banner svg{width:14px;height:14px;flex:none}
.sdw-nc-banner-error{color:var(--dsw-alias-state-error-primary)}
.sdw-nc-link{border:none;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer;padding:0 2px}
.sdw-nc-tail{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:2px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.sdw-nc-tail-meta{color:var(--dsw-alias-label-tertiary)}
.sdw-nc-tail-time{color:var(--dsw-alias-label-tertiary)}
.sdw-nc-tail-copy{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sdw-nc-tail-copy svg{width:14px;height:14px}
.sdw-nc-tail-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdw-nc-error{padding:2px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.sdw-nc-caret{display:inline-block;width:2px;height:1.05em;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-state-business-primary);animation:sdw-nc-blink 1.1s steps(2,start) infinite}
@keyframes sdw-nc-blink{50%{opacity:0}}
.sdw-nc-compact{font-size:calc(13px + var(--dsh-content-font-delta,0px))}
.sdw-nc-row{display:block;min-width:0}
.sdw-nc-assistant{display:block;min-width:0}
.sdw-nc-sep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.sdw-nc-reasoning-summary{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:20px}
.sdw-nc-thinking{padding:4px 0 4px 22px}
.sdw-nc-process{display:flex;flex-direction:column;min-width:0}
.sdw-nc-process-head{display:flex;align-items:center;gap:6px;width:100%;height:calc(24px + var(--dsh-content-font-delta,0px));padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:24px;text-align:left;cursor:pointer}
.sdw-nc-process-head:hover{color:var(--dsw-alias-label-secondary)}
.sdw-nc-process-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sdw-nc-process-chevron{width:14px;height:14px;flex:none;transition:transform .15s}
.sdw-nc-process-head[data-open] .sdw-nc-process-chevron{transform:rotate(180deg)}
.sdw-nc-process-body{padding:4px 0 4px 22px}
.sdw-nc-process-content{display:flex;flex-direction:column;gap:2px;min-width:0}
.sdw-nc-duration{font-variant-numeric:tabular-nums}
.sdw-nc-ta{display:block;box-sizing:border-box;width:100%;border:none;background:transparent;resize:none;outline:none;font-family:inherit;overflow-y:auto;max-height:calc(var(--dsh-composer-text-max-height,336px) - 4px)}
.sdw-nc-chip{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:default}
.sdw-nc-perm-icon{width:13px;height:13px}
.sdw-nc-perm-chevron{width:12px;height:12px;opacity:.7}
.sdw-nc-model-trigger{display:inline-flex;align-items:center;gap:6px;max-width:260px;font-weight:500}
.sdw-nc-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-nc-effort{color:var(--dsw-alias-label-tertiary);font-weight:400;flex:none}
.sdw-nc-modelmenu{position:fixed;z-index:2147483005;display:flex;flex-direction:column;gap:2px;max-height:400px;overflow-y:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#232325));box-shadow:0 8px 24px #00000040;backdrop-filter:blur(16px);min-width:0}
.sdw-nc-modelmenu[data-view=root]{width:232px}
.sdw-nc-modelmenu[data-view=models]{width:304px;padding:4px 4px 8px}
.sdw-nc-modelmenu[data-view=effort]{width:220px}
.sdw-nc-menu-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.sdw-nc-menu-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sdw-nc-menu-row:disabled{opacity:.5;cursor:default}
.sdw-nc-menu-row-label{flex:none;font-weight:500}
.sdw-nc-menu-row-value{flex:1;min-width:0;text-align:right;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-nc-menu-row-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary)}
.sdw-nc-menu-search{box-sizing:border-box;width:calc(100% - 8px);margin:4px 4px 6px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,#2a2b2d);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.sdw-nc-menu-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.sdw-nc-menu-empty{padding:10px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sdw-nc-menu-group{display:flex;flex-direction:column;gap:1px;padding:2px 0}
.sdw-nc-menu-group+.sdw-nc-menu-group{margin-top:2px;border-top:.5px solid var(--dsw-alias-border-l2,#ffffff14);padding-top:4px}
.sdw-nc-menu-label{padding:2px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.sdw-nc-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.sdw-nc-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-nc-menu-item.selected{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdw-nc-menu-item.selected svg{color:var(--dsw-alias-label-primary)}
.sdw-nc-menu-item>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-nc-menu-item svg{width:14px;height:14px;flex:none}
.sdw-nc-mic{display:grid;place-items:center;width:28px;height:28px;flex:none;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sdw-nc-mic:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdw-nc-mic:disabled{cursor:default;opacity:.5}
.sdw-nc-mic[data-busy]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sdw-nc-permmenu{position:fixed;z-index:2147483005;display:flex;flex-direction:column;gap:2px;width:248px;padding:4px;border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#232325));box-shadow:0 8px 24px #00000040;backdrop-filter:blur(16px)}
.sdw-nc-perm-item{display:flex;align-items:flex-start;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.sdw-nc-perm-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-nc-perm-item.selected{background:var(--dsw-alias-interactive-bg-hover)}
.sdw-nc-perm-item-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.sdw-nc-perm-item-name{font-size:13px;line-height:20px;font-weight:500}
.sdw-nc-perm-item-desc{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.sdw-nc-perm-item>svg{width:14px;height:14px;flex:none;margin-top:3px}
.sdw-nc-badge{display:inline-flex;align-items:center;height:14px;padding:0 4px;margin-left:6px;border-radius:4px;background:var(--dsw-alias-bg-layer-1,#2a2b2d);color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:600;letter-spacing:.4px;vertical-align:1px}
.sdw-nc-confirm-wrap{position:fixed;inset:0;z-index:2147483006;display:flex;align-items:center;justify-content:center;background:#00000059}
.sdw-nc-confirm{width:min(420px,calc(100vw - 48px));padding:18px;border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#232325));box-shadow:0 16px 48px #00000059;display:flex;flex-direction:column;gap:10px}
.sdw-nc-confirm-title{font-size:15px;line-height:22px;font-weight:600}
.sdw-nc-confirm-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sdw-nc-confirm-ack{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;cursor:pointer}
.sdw-nc-confirm-ack input{margin:3px 0 0;flex:none}
.sdw-nc-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.sdw-nc-confirm-btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.sdw-nc-confirm-btn.primary{background:var(--dsw-alias-business-primary,#4d6bfe);border-color:transparent;color:#fff}
.sdw-nc-confirm-btn.danger{background:var(--dsw-alias-danger-primary,#e5484d);border-color:transparent;color:#fff}
.sdw-nc-confirm-btn:disabled{opacity:.5;cursor:default}
.sdw-nc-addmenu{position:fixed;z-index:2147483005;display:flex;flex-direction:column;gap:2px;width:232px;padding:4px;border:.5px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#232325));box-shadow:0 8px 24px #00000040;backdrop-filter:blur(16px)}
.sdw-nc-attachrail{display:flex;gap:8px;padding:8px 10px 0;overflow-x:auto;scrollbar-width:none}
.sdw-nc-attachrail::-webkit-scrollbar{display:none}
.sdw-nc-attach{display:flex;align-items:center;gap:8px;height:48px;max-width:240px;padding:0 8px;flex:none;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#2a2b2d)}
.sdw-nc-attach[data-state=error]{outline:.5px solid var(--dsw-alias-danger-primary,#e5484d)}
.sdw-nc-attach-thumb{width:32px;height:32px;flex:none;object-fit:cover;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#232325)}
.sdw-nc-attach-glyph{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#232325);color:var(--dsw-alias-label-secondary)}
.sdw-nc-attach-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.sdw-nc-attach-name{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-nc-attach-sub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdw-nc-attach-remove{display:grid;place-items:center;width:18px;height:18px;flex:none;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.sdw-nc-attach-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdw-nc-voicebar{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 14px}
.sdw-nc-voice-dot{width:8px;height:8px;flex:none;border-radius:999px;background:var(--dsw-alias-label-tertiary)}
.sdw-nc-voice-dot.on{background:var(--dsw-alias-danger-primary,#e5484d);animation:sdw-nc-pulse 1s ease-in-out infinite}
@keyframes sdw-nc-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sdw-nc-voice-label{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.sdw-nc-voice-btn{height:26px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#2a2b2d);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.sdw-nc-voice-btn.primary{background:var(--dsw-alias-business-primary,#4d6bfe);color:#fff}
.sdw-nc-voice-hint{display:flex;align-items:center;gap:8px;padding:6px 14px 0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sdw-nc-voice-hint button{height:24px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#2a2b2d);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;flex:none}
.sdw-nc-voice-hint button:disabled{opacity:.5;cursor:default}`
    }

    async function api(route, action, payload = {}, options = {}) {
      // `options.headers` lets one action opt into a wider Host body cap (the
      // voice route accepts an 8 MB body only when the header names it).
      const headers = { 'content-type': 'application/json', 'x-shadow-client': '1', ...(options.headers || {}) }
      const response = await fetch(route, {
        method: action ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers,
        // The route action is authoritative: a payload step must never be able
        // to masquerade as the data-route action (0.9.0 shipped `push-file`
        // steps on `action`, which turned every step into "unknown action").
        body: action ? JSON.stringify({ ...payload, action }) : undefined,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const value = await response.json().catch(() => ({ ok: false, error: { message: 'invalid JSON from host' } }))
      if (!response.ok || value.ok === false) {
        const error = new Error(value?.error?.message || `HTTP ${response.status}`)
        error.code = value?.error?.code || ''
        throw error
      }
      return value
    }

    const panelApi = (action, payload, options) => api(PANEL_ROUTE, action, payload, options)
    const dataApi = (action, payload, options) => api(DATA_ROUTE, action, payload, options)

    /**
     * Best-effort browser diagnostics to the Host's debug.log. Never sends
     * prompt/assistant text — only slot keys, page lifecycle and error first
     * lines. Throttled per message so a failing loop cannot flood the log.
     */
    const debugSeen = new Map()
    function clientDebug(scope, message, level = 'debug') {
      try {
        const text = String(message ?? '').slice(0, 800)
        const key = `${level}|${scope}|${text}`
        const now = Date.now()
        const last = debugSeen.get(key) || 0
        if (now - last < 10000) return
        debugSeen.set(key, now)
        if (debugSeen.size > 200) debugSeen.clear()
        void fetch(PANEL_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-shadow-client': '1' },
          body: JSON.stringify({ action: 'client-log', scope: String(scope).slice(0, 40), level, message: text }),
        }).catch(() => {})
      } catch {}
    }

    /** First stack line of a browser error. */
    function errorLine(error) {
      const stack = error && typeof error.stack === 'string' ? error.stack : ''
      const line = stack.split('\n').map((entry) => entry.trim()).filter(Boolean)[0]
      return line || (error && error.message) || String(error)
    }

    function textOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n').trim()
    }

    // DSH records host-injected context (runtime snapshot, skill catalog, clock)
    // as user/message events whose source.kind is not "user". Native DSH hides
    // them from the transcript; mirror that instead of showing raw system text.
    function isInjectedUserMessage(message) {
      const kind = message && message.source && message.source.kind
      return typeof kind === 'string' && kind !== '' && kind !== 'user'
    }

    function relTime(iso) {
      const ms = Date.parse(iso || '')
      if (!Number.isFinite(ms)) return ''
      const diff = Date.now() - ms
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`
      if (diff < 172_800_000) return '昨天'
      const date = new Date(ms)
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    // -----------------------------------------------------------------------
    // Markdown: pure block parser + token renderer (0.10.0).
    // The parser is exported through __shadowTesting; the renderer only maps
    // parsed blocks to React nodes so tables/fences keep native-like spacing.
    // -----------------------------------------------------------------------

    /** Inline token renderer: code, bold, italic, strike, links, line breaks. */
    function renderInline(text, keyPrefix = 'i') {
      const value = String(text ?? '')
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>()]+)/
      const nodes = []
      let key = 0
      for (const piece of value.split('\n')) {
        if (nodes.length) nodes.push(h('br', { key: `${keyPrefix}br${key++}` }))
        let rest = piece
        let guard = 0
        while (rest && guard < 500) {
          guard += 1
          const match = pattern.exec(rest)
          if (!match) { nodes.push(rest); break }
          if (match.index > 0) nodes.push(rest.slice(0, match.index))
          const token = match[0]
          if (token.startsWith('`')) {
            nodes.push(h('code', { key: `${keyPrefix}c${key++}` }, token.slice(1, -1)))
          } else if (token.startsWith('**') || token.startsWith('__')) {
            nodes.push(h('strong', { key: `${keyPrefix}b${key++}` }, renderInline(token.slice(2, -2), `${keyPrefix}b${key++}-`)))
          } else if (token.startsWith('~~')) {
            nodes.push(h('del', { key: `${keyPrefix}d${key++}` }, renderInline(token.slice(2, -2), `${keyPrefix}d${key++}-`)))
          } else if (token.startsWith('[')) {
            const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
            nodes.push(h('a', {
              key: `${keyPrefix}a${key++}`,
              href: link ? link[2] : '#',
              target: '_blank',
              rel: 'noreferrer',
            }, renderInline(link ? link[1] : token, `${keyPrefix}l${key++}-`)))
          } else if (token.startsWith('http')) {
            nodes.push(h('a', { key: `${keyPrefix}u${key++}`, href: token, target: '_blank', rel: 'noreferrer' }, token))
          } else {
            nodes.push(h('em', { key: `${keyPrefix}e${key++}` }, renderInline(token.slice(1, -1), `${keyPrefix}e${key++}-`)))
          }
          rest = rest.slice(match.index + token.length)
        }
      }
      return nodes
    }

    const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
    const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
    const MD_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
    const MD_QUOTE = /^\s{0,3}>\s?/
    const MD_UL = /^(\s*)[-*+]\s+(.*)$/
    const MD_OL = /^(\s*)\d+[.)]\s+(.*)$/
    const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/

    /** Split one table row into trimmed cells. */
    function mdCells(line) {
      return String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
    }

    /** True when `line` starts a block other than a paragraph. */
    function mdStartsBlock(line, next) {
      return Boolean(
        MD_FENCE.test(line)
        || MD_HEADING.test(line)
        || MD_HR.test(line)
        || MD_QUOTE.test(line)
        || MD_UL.test(line)
        || MD_OL.test(line)
        || (String(line).includes('|') && next !== undefined && MD_TABLE_SEP.test(String(next))),
      )
    }

    /** Parse nested list items starting at `start`; returns `[items, nextIndex]`. */
    function mdList(lines, start) {
      const items = []
      let index = start
      let baseIndent = -1
      let ordered = false
      while (index < lines.length) {
        const line = lines[index]
        if (!line.trim()) break
        const ul = MD_UL.exec(line)
        const ol = MD_OL.exec(line)
        const match = ul || ol
        if (!match) break
        const indent = match[1].replace(/\t/g, '  ').length
        if (baseIndent < 0) {
          baseIndent = indent
          ordered = Boolean(ol)
        } else if (indent < baseIndent) {
          break
        }
        items.push({
          text: match[2],
          depth: Math.max(0, Math.min(2, Math.round((indent - baseIndent) / 2))),
        })
        index += 1
      }
      return [{ type: 'list', ordered, items }, index]
    }

    /**
     * Parse GFM-lite markdown into block descriptors.
     * @param {string} text - markdown source.
     * @returns {Array<object>} blocks: heading|paragraph|code|table|list|quote|hr.
     */
    function markdownBlocks(text) {
      const source = String(text ?? '').replace(/\r\n?/g, '\n')
      const lines = source.split('\n')
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (!line.trim()) { index += 1; continue }
        const fence = MD_FENCE.exec(line)
        if (fence) {
          const marker = fence[1][0]
          const lang = fence[2]
          const code = []
          index += 1
          while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          blocks.push({ type: 'code', lang, code: code.join('\n') })
          continue
        }
        if (line.includes('|') && index + 1 < lines.length && MD_TABLE_SEP.test(lines[index + 1])) {
          const head = mdCells(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
            rows.push(mdCells(lines[index]))
            index += 1
          }
          blocks.push({ type: 'table', head, rows })
          continue
        }
        const heading = MD_HEADING.exec(line)
        if (heading) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
          index += 1
          continue
        }
        if (MD_HR.test(line)) {
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }
        if (MD_QUOTE.test(line)) {
          const quote = []
          while (index < lines.length && MD_QUOTE.test(lines[index])) {
            quote.push(lines[index].replace(MD_QUOTE, ''))
            index += 1
          }
          blocks.push({ type: 'quote', text: quote.join('\n') })
          continue
        }
        if (MD_UL.test(line) || MD_OL.test(line)) {
          const [block, next] = mdList(lines, index)
          blocks.push(block)
          index = next
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length && lines[index].trim() && !mdStartsBlock(lines[index], lines[index + 1])) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
      }
      return blocks
    }

    /** Render one parsed markdown block (paragraph/heading/...) to a node. */
    function markdownBlockNode(block, index, t) {
      switch (block.type) {
        case 'heading':
          return h(`h${Math.min(6, Math.max(1, block.level))}`, { key: `md${index}` }, renderInline(block.text, `md${index}-`))
        case 'hr':
          return h('hr', { key: `md${index}` })
        case 'code':
          return h(CodeBlock, { key: `md${index}`, lang: block.lang, code: block.code, t })
        case 'table':
          return h('div', { key: `md${index}`, className: 'sdc-table-wrap', tabIndex: 0, role: 'region' },
            h('table', { className: 'sdc-table' },
              h('thead', null, h('tr', null, block.head.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell, `md${index}h${cellIndex}-`))))),
              h('tbody', null, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
                block.head.map((_, cellIndex) => h('td', { key: cellIndex }, renderInline(row[cellIndex] ?? '', `md${index}r${rowIndex}c${cellIndex}-`))))))))
        case 'quote':
          return h('blockquote', { key: `md${index}` }, h(Markdown, { text: block.text, compact: true, t }))
        case 'list': {
          // Flat items with a depth become a nested tree; one <ul>/<ol> per
          // level so GFM nesting renders like the native markdown view.
          const root = []
          const stack = [{ depth: -1, children: root }]
          for (const item of block.items) {
            while (stack.length > 1 && item.depth <= stack[stack.length - 1].depth) stack.pop()
            const parent = stack[stack.length - 1]
            const node = { text: item.text, children: [] }
            parent.children.push(node)
            stack.push({ depth: item.depth, children: node.children })
          }
          const renderList = (items, ordered, level) => h(ordered && level === 0 ? 'ol' : 'ul', { key: `md${index}l${level}-${items.length}` },
            items.map((item, itemIndex) => h('li', { key: `md${index}i${level}-${itemIndex}` },
              renderInline(item.text, `md${index}i${level}${itemIndex}-`),
              item.children.length ? renderList(item.children, ordered, level + 1) : null)))
          return renderList(root, block.ordered, 0)
        }
        default:
          return h('p', { key: `md${index}` }, renderInline(block.text, `md${index}-`))
      }
    }

    /**
     * Render markdown source. `streaming` appends a blinking caret to the last
     * text block (the shadow client has no token-level markdown stream).
     */
    function Markdown({ text, streaming, compact, t }) {
      const blocks = useMemo(() => markdownBlocks(text), [text])
      const nodes = blocks.map((block, index) => markdownBlockNode(block, index, t))
      if (streaming) nodes.push(h('span', { key: 'md-caret', className: 'sdc-caret', 'aria-hidden': 'true' }))
      return h('div', { className: `sdc-md${compact ? ' sdc-md-compact' : ''}` }, nodes)
    }

    /** Reasoning blocks of one assistant message (durable event shape). */
    function reasoningOf(blocks) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n\n')
    }

    /** Session status shown by the list and chat header. */
    function statusOf(session, approvals = []) {
      if (!session) return { kind: 'idle', key: 'statusIdle', dot: '' }
      if (session.lost || session.status === 'lost') return { kind: 'lost', key: 'statusLost', dot: 'err' }
      if ((approvals || []).length > 0) return { kind: 'waiting', key: 'statusWaiting', dot: 'warn' }
      if (session.status === 'running') return { kind: 'running', key: 'statusRunning', dot: 'run' }
      const reason = session.turnReason?.kind
      if (reason === 'completed') return { kind: 'done', key: 'statusDone', dot: 'on' }
      if (reason === 'error') return { kind: 'failed', key: 'statusFailed', dot: 'err' }
      if (reason === 'aborted') return { kind: 'stopped', key: 'statusStopped', dot: '' }
      if (reason === 'blocked') return { kind: 'blocked', key: 'statusStopped', dot: 'warn' }
      return { kind: 'idle', key: 'statusIdle', dot: 'on' }
    }

    function Dot({ dot }) {
      return h('span', { className: `sdw-dot ${dot || ''}` })
    }

    function Switch({ on, disabled, onChange, label }) {
      return h('button', {
        className: `sdw-switch${on ? ' on' : ''}`,
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label || 'toggle',
        disabled,
        onClick: () => { if (!disabled) onChange(!on) },
      })
    }

    // -----------------------------------------------------------------------
    // Transcript helpers (pure; also exposed to tests through __shadowTesting).
    // -----------------------------------------------------------------------

    const MAX_DIFF_LINES = 160

    /** Parse a tool-call argument payload (JSON string from the Host or object). */
    function parseArgs(value) {
      if (value && typeof value === 'object') return value
      if (typeof value !== 'string' || !value.trim()) return null
      try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    /** First non-empty string field among `keys`. */
    function pickString(object, keys) {
      if (!object || typeof object !== 'object') return ''
      for (const key of keys) {
        const value = object[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
      return ''
    }

    /** Classify a tool name into the card families the native chat uses. */
    function toolKind(name) {
      const raw = String(name || '').toLowerCase().replace(/[\s_-]+/g, '')
      // Native renders ask_user_question as its own "提问" row (0.10.25).
      if (/^(askuserquestion|askuser|askquestion)$/.test(raw)) return 'question'
      if (/^(edit|multiedit|strreplace|replace|applypatch|patch)$/.test(raw) || /edit|patch/.test(raw)) return 'edit'
      if (/^(write|writefile|createfile|savefile|appendfile|create)$/.test(raw) || /write|createfile/.test(raw)) return 'write'
      if (/^(read|readfile|cat|view|openfile)$/.test(raw) || /read/.test(raw)) return 'read'
      if (/^(grep|search|ripgrep|findinfile)$/.test(raw) || /grep|search/.test(raw)) return 'grep'
      if (/^(glob|find|listfiles|ls|dir)$/.test(raw) || /glob/.test(raw)) return 'glob'
      if (/^(pwsh|powershell|bash|shell|sh|zsh|cmd|terminal|exec|run|runcommand|command)$/.test(raw) || /shell|pwsh|bash/.test(raw)) return 'command'
      if (/^(job|jobs|background|backgroundjob|spawn|task|tasks|taskstop)$/.test(raw) || /job|background/.test(raw)) return 'job'
      if (/^skill/.test(raw)) return 'skill'
      if (/web|fetch|browse|http/.test(raw)) return 'web'
      return 'other'
    }

    function toolKindLabel(kind, t) {
      const map = {
        read: 'toolRead', write: 'toolWrite', edit: 'toolEdit', grep: 'toolGrep',
        glob: 'toolGlob', command: 'toolCommand', job: 'toolJob', web: 'toolWeb', skill: 'toolSkill',
        question: 'toolQuestion', other: 'toolOther',
      }
      return t(map[kind] || 'toolOther')
    }

    /** First non-empty line, truncated. */
    function firstLine(text, max = 120) {
      const value = String(text ?? '').replace(/\r\n/g, '\n').trim()
      if (!value) return ''
      const line = value.split('\n').find((entry) => entry.trim()) || ''
      const trimmed = line.trim()
      return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
    }

    function formatDuration(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1000) return `${Math.round(n)}ms`
      if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`
      const minutes = Math.floor(n / 60_000)
      const seconds = Math.round((n % 60_000) / 1000)
      return `${minutes}m${seconds ? ` ${seconds}s` : ''}`
    }

    // -----------------------------------------------------------------------
    // Transcript grouping + tool facts (pure; exposed through __shadowTesting).
    // Mirrors the native chat flow: user row, process block (reasoning + tools
    // + commands + jobs), assistant reply, turn tail. Completed process blocks
    // collapse; the running one stays open.
    // -----------------------------------------------------------------------

    /** Follow-bottom slack in px (native tolerates a few px of rounding). */
    const SCROLL_FOLLOW_SLACK = 48

    /** Human relative time; pure (tests pass a fixed `now`). */
    function relativeTime(ms, now = Date.now()) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return ''
      const diff = Math.max(0, Number(now) - value)
      if (diff < 45_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
      if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (part) => String(part).padStart(2, '0')
      return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Scroll-follow heuristic: follow while the viewport is within `threshold`
     * of the bottom; the "back to bottom" affordance appears once it is not.
     */
    function scrollFollow({ scrollTop, scrollHeight, clientHeight, threshold = SCROLL_FOLLOW_SLACK }) {
      const top = Number(scrollTop) || 0
      const height = Number(scrollHeight) || 0
      const view = Number(clientHeight) || 0
      const distance = Math.max(0, height - view - top)
      return { distance, atBottom: distance <= 2, following: distance <= Math.max(0, Number(threshold) || 0) }
    }

    /** Count matches/files in a grep/glob result dump. */
    function searchStats(text) {
      const value = String(text ?? '')
      const lines = value.split('\n').filter((line) => line.trim())
      const files = new Set()
      let matches = 0
      for (const line of lines) {
        const hit = /^([^\s:][^:\n]*?):(\d+)(?::\d+)?:/.exec(line)
        if (hit) {
          matches += 1
          files.add(hit[1])
          continue
        }
        // Glob output is a plain path list.
        if (/^[A-Za-z]:[\\/]|^\/|^\.{1,2}\//.test(line)) {
          matches += 1
          files.add(line.trim())
        }
      }
      return { matches, files: files.size, lines: lines.length }
    }

    /** Exit code embedded in a command result, if the runtime recorded one. */
    function exitCodeOf(text, isError = false) {
      const value = String(text ?? '')
      const patterns = [
        /exit code[:\s]+(-?\d+)/i,
        /exited with (?:code|status)[:\s]+(-?\d+)/i,
        /\(exit(?:ed)?[:\s]+(-?\d+)\)/i,
        /\[exit(?:ed)?[:\s]+(-?\d+)\]/i,
        /exit status[:\s]+(-?\d+)/i,
      ]
      for (const pattern of patterns) {
        const hit = pattern.exec(value)
        if (hit) {
          const code = Number(hit[1])
          return { code, failed: code !== 0 || isError === true, label: `退出码 ${code}` }
        }
      }
      if (isError) return { code: null, failed: true, label: '未正常退出' }
      return null
    }

    /** Normalize one durable tool row into the facts the native-like row shows. */
    function toolRowModel(row, t = (key) => key) {
      const kind = row?.kind || 'other'
      const argsObject = parseArgs(row?.args)
      const output = String(row?.result ?? '')
      const finished = row?.result !== undefined && row?.result !== null
      const state = row?.isError ? 'error' : finished ? 'done' : 'running'
      const model = {
        kind,
        name: String(row?.name || ''),
        state,
        finished,
        args: argsObject,
        path: '',
        diff: null,
        write: null,
        command: null,
        read: null,
        search: null,
        web: null,
        output,
        suffix: '',
        exit: null,
        diffStat: null,
      }
      if (kind === 'edit') {
        const edit = extractEdit(row?.args)
        if (edit) {
          model.path = edit.path
          model.diff = edit.diff
          model.diffStat = { added: edit.diff.added, removed: edit.diff.removed }
        } else {
          model.path = pickString(argsObject, ['path', 'file_path', 'filePath', 'file'])
        }
      } else if (kind === 'write') {
        const write = extractWrite(row?.args)
        model.path = write?.path || pickString(argsObject, ['path', 'file_path'])
        if (write) {
          model.write = {
            path: write.path,
            content: write.content,
            lines: write.content.split('\n').length,
          }
          model.suffix = `${model.write.lines} ${t('linesUnit')}`
        }
      } else if (kind === 'command') {
        const command = pickString(argsObject, ['command', 'cmd', 'script', 'input', 'code'])
        model.command = {
          text: command || firstLine(row?.args, 120) || model.name,
          output,
          cwd: pickString(argsObject, ['cwd', 'workdir', 'workingDirectory']),
        }
        model.exit = exitCodeOf(output, row?.isError === true)
      } else if (kind === 'read') {
        const path = pickString(argsObject, ['path', 'file_path', 'filePath', 'file'])
        const offset = argsObject?.offset ?? argsObject?.start
        const limit = argsObject?.limit
        model.read = {
          path,
          offset: offset === undefined || offset === null ? null : Number(offset),
          limit: limit === undefined || limit === null ? null : Number(limit),
          output,
          lines: output ? output.split('\n').length : 0,
        }
        model.path = path
        if (model.read.lines > 0) model.suffix = `${model.read.lines} ${t('linesUnit')}`
      } else if (kind === 'grep' || kind === 'glob') {
        const pattern = pickString(argsObject, ['pattern', 'query', 'regex', 'search', 'glob'])
        model.search = {
          pattern,
          path: pickString(argsObject, ['path', 'glob', 'cwd']),
          output,
          ...searchStats(output),
        }
        if (model.search.matches > 0) {
          model.suffix = kind === 'grep'
            ? `${model.search.matches} ${t('matchesUnit')} · ${model.search.files} ${t('filesUnit')}`
            : `${model.search.matches} ${t('pathsUnit')}`
        }
      } else if (kind === 'web') {
        model.web = { url: pickString(argsObject, ['url', 'href']) }
      } else if (kind === 'job') {
        model.path = pickString(argsObject, ['label', 'name', 'description']) || String(row?.jobId || '')
      } else {
        model.path = pickString(argsObject, ['path', 'file_path', 'url', 'pattern', 'query', 'label'])
      }
      return model
    }

    /** Per-process-block counts used by the collapsed group header. */
    function processStats(block) {
      const stats = {
        running: false,
        reasoning: 0,
        reasoningMs: 0,
        tools: 0,
        commands: 0,
        jobs: 0,
        edits: 0,
        reads: 0,
        searches: 0,
        errors: 0,
      }
      for (const item of block?.items || []) {
        if (item.kind === 'reasoning') {
          stats.reasoning += 1
          stats.reasoningMs += Number(item.durationMs) || 0
          if (item.streaming) stats.running = true
        } else if (item.kind === 'tool') {
          stats.tools += 1
          const toolKindName = item.row?.kind
          if (toolKindName === 'edit' || toolKindName === 'write') stats.edits += 1
          else if (toolKindName === 'read') stats.reads += 1
          else if (toolKindName === 'grep' || toolKindName === 'glob') stats.searches += 1
          if (item.row?.result === undefined) stats.running = true
          if (item.row?.isError) stats.errors += 1
        } else if (item.kind === 'command') {
          stats.commands += 1
          if (!item.row?.done) stats.running = true
          if (item.row?.failed) stats.errors += 1
        } else if (item.kind === 'job') {
          stats.jobs += 1
          if (!item.row?.finishedAt) stats.running = true
        } else if (item.kind === 'error') {
          stats.errors += 1
        }
      }
      return stats
    }

    /** True when a tool row is still executing (spinner in the leading box). */
    function toolRowRunning(row) {
      return Boolean(row) && row.result === undefined && row.kind !== 'todo'
    }

    /**
     * Group durable session events into native-like turns.
     * @param {Array<object>} events - forwarded session events (`{type, seq, time, data}`).
     * @returns {{turns: Array<object>}}
     */
    function buildTranscript(events) {
      const list = Array.isArray(events) ? events : []
      const toolRows = new Map()
      const commandRows = new Map()
      const jobRows = new Map()
      let lastTodoIndex = -1
      list.forEach((event, index) => { if (event?.type === 'todo/write') lastTodoIndex = index })

      // Pre-merge paired events so a row rendered at its first event already
      // carries the result that arrived later in the same batch.
      for (const event of list) {
        const data = event?.data || {}
        if (event?.type === 'tool/call') {
          const callId = String(data.callId || '')
          if (!callId) continue
          const kind = toolKind(data.name)
          toolRows.set(callId, {
            callId,
            name: String(data.name || 'tool'),
            kind,
            args: data.arguments === undefined
              ? ''
              : typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments),
            summary: toolSummary(kind, data.name, data.arguments),
            result: undefined,
            isError: false,
            startedAt: Number(event.time) || 0,
            finishedAt: 0,
            durationMs: 0,
          })
        } else if (event?.type === 'tool/result') {
          const callId = String(data.message?.toolCallId || '')
          if (!callId) continue
          const result = toolResultOf(event)
          const row = toolRows.get(callId)
          if (row) {
            row.result = result.text
            row.isError = result.isError
            row.finishedAt = Number(event.time) || 0
            row.durationMs = row.startedAt && row.finishedAt > row.startedAt ? row.finishedAt - row.startedAt : 0
          } else {
            toolRows.set(callId, {
              callId,
              name: String(data.message?.name || 'tool'),
              kind: 'other',
              args: '',
              summary: '',
              result: result.text,
              isError: result.isError,
              startedAt: 0,
              finishedAt: Number(event.time) || 0,
              durationMs: 0,
            })
          }
        } else if (event?.type === 'command/run') {
          const commandId = String(data.commandId || '')
          commandRows.set(commandId, {
            commandId,
            name: String(data.name || ''),
            args: String(data.args || ''),
            output: '',
            done: false,
            failed: false,
            at: Number(event.time) || 0,
          })
        } else if (event?.type === 'command/done') {
          const commandId = String(data.commandId || '')
          const failed = data.kind === 'error'
          const row = commandRows.get(commandId)
          if (row) {
            row.done = true
            row.failed = failed
            row.output = String(data.text || '')
          } else {
            commandRows.set(commandId, {
              commandId,
              name: '',
              args: '',
              output: String(data.text || ''),
              done: true,
              failed,
              at: Number(event.time) || 0,
            })
          }
        } else if (event?.type === 'job/registered') {
          const jobId = String(data.jobId || '')
          jobRows.set(jobId, { ...data, jobId })
        } else if (event?.type === 'job/settled') {
          const jobId = String(data.jobId || '')
          jobRows.set(jobId, { ...(jobRows.get(jobId) || {}), ...data, jobId })
        }
      }
      // assistant messages carry the same tool-call blocks; seed rows that never
      // saw a standalone `tool/call` (B-side report: tools disappeared).
      for (const event of list) {
        if (event?.type !== 'assistant/message') continue
        for (const block of event.data?.message?.content || []) {
          if (!block || block.type !== 'tool-call') continue
          const callId = String(block.id || '')
          if (!callId || toolRows.has(callId)) continue
          const kind = toolKind(block.name)
          toolRows.set(callId, {
            callId,
            name: String(block.name || 'tool'),
            kind,
            args: block.arguments === undefined
              ? ''
              : typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments),
            summary: toolSummary(kind, block.name, block.arguments),
            result: undefined,
            isError: false,
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
          })
        }
      }

      const turns = []
      const seenTools = new Set()
      const seenCommands = new Set()
      const seenJobs = new Set()
      let turn = null
      let block = null
      let stepStartedAt = 0
      let previousModel = ''
      let previousSandbox = ''
      let previousPermission = ''
      let previousCwd = ''
      let reasoningCount = 0

      const openTurn = (at) => {
        turn = {
          key: `turn-${turns.length}`,
          at: Number(at) || 0,
          user: null,
          blocks: [],
          tail: null,
          interrupted: false,
        }
        turns.push(turn)
        block = null
        return turn
      }
      const currentTurn = (at) => {
        if (!turn || turn.tail) return openTurn(at)
        return turn
      }
      const processBlock = (at) => {
        const owner = currentTurn(at)
        if (!block || block.kind !== 'process' || block.closed) {
          block = { kind: 'process', key: `${owner.key}-p${owner.blocks.length}`, items: [], closed: false }
          owner.blocks.push(block)
        }
        return block
      }
      const closeProcess = () => { block = null }
      const pushItem = (at, item) => {
        const target = processBlock(at)
        target.items.push(item)
        return target
      }

      for (let index = 0; index < list.length; index += 1) {
        const event = list[index]
        const data = event?.data || {}
        const at = Number(event?.time) || 0
        switch (event?.type) {
          case 'user/message': {
            // Injected runtime/skill/time context is not a real user turn.
            if (isInjectedUserMessage(data.message)) break
            const text = textOf(data.message?.content)
            const owner = !turn || turn.user || turn.blocks.length ? openTurn(at) : turn
            owner.user = { text, at, seq: event.seq }
            closeProcess()
            stepStartedAt = at
            break
          }
          case 'turn/start': {
            if (turn?.tail) openTurn(at)
            else currentTurn(at)
            stepStartedAt = at
            break
          }
          case 'step/start': {
            currentTurn(at)
            stepStartedAt = at
            break
          }
          case 'assistant/message': {
            const owner = currentTurn(at)
            const reasoning = reasoningOf(data.message?.content)
            if (reasoning) {
              reasoningCount += 1
              pushItem(at, {
                kind: 'reasoning',
                key: `${owner.key}-r${reasoningCount}`,
                text: reasoning,
                at: stepStartedAt || at,
                durationMs: stepStartedAt && at > stepStartedAt ? at - stepStartedAt : 0,
                streaming: false,
              })
            }
            const text = textOf(data.message?.content)
            if (text) {
              closeProcess()
              owner.blocks.push({ kind: 'response', key: `${owner.key}-a${owner.blocks.length}`, text, at, seq: event.seq })
            }
            if (data.interrupted) owner.interrupted = true
            for (const content of data.message?.content || []) {
              if (!content || content.type !== 'tool-call') continue
              const callId = String(content.id || '')
              const row = toolRows.get(callId)
              if (!row || seenTools.has(callId)) continue
              seenTools.add(callId)
              pushItem(at, { kind: 'tool', key: `t-${callId}`, callId, row })
            }
            break
          }
          case 'tool/call': {
            const callId = String(data.callId || '')
            const row = toolRows.get(callId)
            if (!row || seenTools.has(callId)) break
            seenTools.add(callId)
            pushItem(at, { kind: 'tool', key: `t-${callId}`, callId, row })
            break
          }
          case 'tool/result': {
            const callId = String(data.message?.toolCallId || '')
            const row = toolRows.get(callId)
            if (!row || seenTools.has(callId)) break
            seenTools.add(callId)
            pushItem(at, { kind: 'tool', key: `t-${callId}`, callId, row })
            break
          }
          case 'command/run': {
            const commandId = String(data.commandId || '')
            const row = commandRows.get(commandId)
            if (!row || seenCommands.has(commandId)) break
            seenCommands.add(commandId)
            pushItem(at, { kind: 'command', key: `c-${commandId}`, commandId, row })
            break
          }
          case 'command/done': {
            const commandId = String(data.commandId || '')
            const row = commandRows.get(commandId)
            if (!row || seenCommands.has(commandId)) break
            seenCommands.add(commandId)
            pushItem(at, { kind: 'command', key: `c-${commandId}`, commandId, row })
            break
          }
          case 'job/registered':
          case 'job/settled': {
            const jobId = String(data.jobId || '')
            const row = jobRows.get(jobId)
            if (!row || seenJobs.has(jobId)) break
            seenJobs.add(jobId)
            pushItem(at, { kind: 'job', key: `j-${jobId}`, jobId, row })
            break
          }
          case 'todo/write': {
            if (index !== lastTodoIndex) break
            const todos = Array.isArray(data.todos) ? data.todos : []
            if (todos.length) pushItem(at, { kind: 'todo', key: `td-${event.seq}`, todos })
            break
          }
          case 'assistant/attempt': {
            if (data.error) {
              pushItem(at, {
                kind: 'error',
                key: `e-${event.seq}`,
                text: `${statusOf({ turnReason: { kind: 'error' }, status: 'idle' }, []).key}: ${data.error.message || data.error.code || ''}`,
              })
            }
            break
          }
          case 'model/selection': {
            const key = `${data.provider || ''}::${data.model || ''}`
            if (key !== previousModel) {
              previousModel = key
              pushItem(at, { kind: 'chip', key: `m-${event.seq}`, labelKey: 'eventModel', value: String(data.model || data.provider || '') })
            }
            break
          }
          case 'sandbox/mode': {
            const mode = String(data.mode || '')
            if (mode && mode !== previousSandbox) {
              previousSandbox = mode
              pushItem(at, { kind: 'chip', key: `sb-${event.seq}`, labelKey: 'eventSandbox', value: mode })
            }
            break
          }
          case 'permission/preset': {
            const preset = String(data.preset || '')
            if (preset && preset !== previousPermission) {
              previousPermission = preset
              pushItem(at, { kind: 'chip', key: `pm-${event.seq}`, labelKey: 'eventPermission', value: preset })
            }
            break
          }
          case 'working-directory/change': {
            const cwd = String(data.cwd || '')
            if (cwd && cwd !== previousCwd) {
              previousCwd = cwd
              pushItem(at, { kind: 'chip', key: `wd-${event.seq}`, labelKey: 'eventCwd', value: cwd })
            }
            break
          }
          case 'approval/decided': {
            const outcome = String(data.outcome || '')
            pushItem(at, {
              kind: 'chip',
              key: `ad-${event.seq}`,
              labelKey: 'approvalEvent',
              value: outcome === 'allowed-once' ? 'approvedOnce' : outcome === 'rejected' ? 'rejectedOnce' : 'approvalUnavailable',
              valueKey: true,
            })
            break
          }
          case 'turn/end': {
            const owner = currentTurn(at)
            owner.tail = { at, reason: data.reason || '' }
            closeProcess()
            break
          }
          default:
            break
        }
      }
      return { turns }
    }

    /**
     * Append the live (streaming, not yet durable) reasoning/reply to the last
     * turn. A closed turn gets a synthetic live turn so the running state never
     * overwrites a finished answer.
     * @param {Array<object>} turns - durable turns from {@link buildTranscript}.
     * @param {{reasoning?: string, text?: string, running?: boolean, startedAt?: number, now?: number}} live - live state.
     * @returns {Array<object>} turns with live content.
     */
    function attachLive(turns, live) {
      const reasoning = String(live?.reasoning || '')
      const text = String(live?.text || '')
      const now = Number(live?.now) || Date.now()
      const running = live?.running === true
      if (!reasoning && !text && !running) return turns
      const out = Array.isArray(turns) ? turns.slice() : []
      let last = out.length ? out[out.length - 1] : null
      if (!last || last.tail) {
        last = { key: `live-${out.length}`, at: now, user: null, blocks: [], tail: null, interrupted: false, live: true }
        out.push(last)
      } else {
        last = { ...last, blocks: last.blocks.slice() }
        out[out.length - 1] = last
      }
      if (reasoning) {
        const previous = last.blocks[last.blocks.length - 1]
        let target = previous && previous.kind === 'process' ? { ...previous, items: previous.items.slice() } : null
        if (!target) {
          target = { kind: 'process', key: `${last.key}-live`, items: [], closed: false }
          last.blocks.push(target)
        } else {
          last.blocks[last.blocks.length - 1] = target
        }
        const index = target.items.findIndex((item) => item.live === true && item.kind === 'reasoning')
        const item = {
          kind: 'reasoning',
          key: `${last.key}-live-reasoning`,
          text: reasoning,
          at: Number(live?.startedAt) || now,
          durationMs: Math.max(0, now - (Number(live?.startedAt) || now)),
          streaming: true,
          live: true,
        }
        if (index >= 0) target.items[index] = item
        else target.items.push(item)
      }
      if (text) {
        const previous = last.blocks[last.blocks.length - 1]
        const response = { kind: 'response', key: `${last.key}-live-text`, text, at: now, streaming: true, live: true }
        if (previous && previous.kind === 'response') last.blocks[last.blocks.length - 1] = response
        else last.blocks.push(response)
      }
      return out
    }

    /** Keep the tail of a long output (command results are most useful there). */
    function tailLines(text, maxLines = 40) {
      const value = String(text ?? '')
      const lines = value.split('\n')
      if (lines.length <= maxLines) return value
      return `… (${lines.length - maxLines} lines hidden)\n${lines.slice(-maxLines).join('\n')}`
    }

    /**
     * Line diff for edit cards: common prefix/suffix are context, the middle is
     * an LCS diff (capped for very large edits).
     * @returns {{rows: Array<{kind: string, text: string}>, added: number, removed: number, total: number, truncated: boolean}}
     */
    function lineDiff(oldText, newText, maxLines = MAX_DIFF_LINES) {
      const before = String(oldText ?? '').replace(/\r\n/g, '\n').split('\n')
      const after = String(newText ?? '').replace(/\r\n/g, '\n').split('\n')
      let start = 0
      while (start < before.length && start < after.length && before[start] === after[start]) start += 1
      let endBefore = before.length - 1
      let endAfter = after.length - 1
      while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
        endBefore -= 1
        endAfter -= 1
      }
      const a = before.slice(start, endBefore + 1)
      const b = after.slice(start, endAfter + 1)
      const rows = []
      for (let i = 0; i < start; i += 1) rows.push({ kind: 'ctx', text: before[i] })
      if (a.length * b.length <= 40_000) {
        const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
        for (let i = a.length - 1; i >= 0; i -= 1) {
          for (let j = b.length - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
          }
        }
        let i = 0
        let j = 0
        while (i < a.length && j < b.length) {
          if (a[i] === b[j]) { rows.push({ kind: 'ctx', text: a[i] }); i += 1; j += 1 }
          else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ kind: 'del', text: a[i] }); i += 1 }
          else { rows.push({ kind: 'add', text: b[j] }); j += 1 }
        }
        while (i < a.length) { rows.push({ kind: 'del', text: a[i] }); i += 1 }
        while (j < b.length) { rows.push({ kind: 'add', text: b[j] }); j += 1 }
      } else {
        for (const line of a) rows.push({ kind: 'del', text: line })
        for (const line of b) rows.push({ kind: 'add', text: line })
      }
      for (let i = endBefore + 1; i < before.length; i += 1) rows.push({ kind: 'ctx', text: before[i] })
      const added = rows.reduce((total, row) => total + (row.kind === 'add' ? 1 : 0), 0)
      const removed = rows.reduce((total, row) => total + (row.kind === 'del' ? 1 : 0), 0)
      const total = rows.length
      const shown = total > maxLines
        ? [...rows.slice(0, Math.max(1, maxLines - 5)), ...rows.slice(-4)]
        : rows
      return { rows: shown, added, removed, total, truncated: total > shown.length }
    }

    /** Extract path + old/new text from an edit tool call (`old_string` etc.). */
    function extractEdit(value) {
      const object = parseArgs(value)
      if (!object) return null
      const path = pickString(object, ['path', 'file_path', 'filePath', 'file', 'target'])
      const oldText = pickString(object, ['old_string', 'oldString', 'old_text', 'oldText', 'old', 'before', 'search'])
      const newText = pickString(object, ['new_string', 'newString', 'new_text', 'newText', 'new', 'replacement', 'replace'])
      if (!oldText && !newText) return null
      return { path, oldText, newText, diff: lineDiff(oldText, newText) }
    }

    /** Extract path + body from a write tool call. */
    function extractWrite(value) {
      const object = parseArgs(value)
      if (!object) return null
      const content = pickString(object, ['content', 'text', 'body', 'data', 'new_string', 'newText'])
      if (!content) return null
      return { path: pickString(object, ['path', 'file_path', 'filePath', 'file']), content }
    }

    /** Compact one-line argument summary shown in a tool card header. */
    function toolSummary(kind, name, value) {
      const object = parseArgs(value)
      if (!object) return typeof value === 'string' ? firstLine(value, 110) : ''
      const path = pickString(object, ['path', 'file_path', 'filePath', 'file', 'target', 'cwd'])
      switch (kind) {
        case 'read': {
          const range = [object.offset ?? object.start, object.limit].filter((entry) => entry !== undefined && entry !== null)
          return `${path || firstLine(value, 80)}${range.length ? ` · ${range.join(':')}` : ''}`
        }
        case 'write': {
          const content = pickString(object, ['content', 'text', 'body'])
          const lines = content ? content.split('\n').length : 0
          return `${path || firstLine(value, 80)}${lines ? ` · ${lines} lines` : ''}`
        }
        case 'edit': {
          const edit = extractEdit(object)
          if (!edit) return path || firstLine(value, 80)
          return `${edit.path || ''} · +${edit.diff.added} -${edit.diff.removed}`
        }
        case 'grep': {
          const pattern = pickString(object, ['pattern', 'query', 'regex', 'search', 'glob'])
          return pattern ? `${pattern}${path ? ` · ${path}` : ''}` : firstLine(value, 100)
        }
        case 'glob':
          return pickString(object, ['pattern', 'glob', 'query', 'path']) || firstLine(value, 100)
        case 'command': {
          const command = pickString(object, ['command', 'cmd', 'script', 'input', 'code'])
          const argList = Array.isArray(object.args)
            ? object.args.join(' ')
            : typeof object.args === 'string' ? object.args : ''
          return [command || name, argList].filter(Boolean).join(' ').trim() || firstLine(value, 120)
        }
        case 'job':
          return pickString(object, ['label', 'name', 'description', 'command', 'cmd']) || firstLine(value, 100)
        default:
          return path
            || pickString(object, ['command', 'cmd', 'pattern', 'query', 'url', 'label'])
            || firstLine(value, 100)
      }
    }

    /** Text of one tool result (`content` blocks) and whether it is an error. */
    function toolResultOf(event) {
      const data = event?.data || {}
      const text = textOf(data.message?.content) || ''
      const error = data.error ? (data.error.message || data.error.code || '') : ''
      const isError = Boolean(data.message?.isError || data.error)
      return { text: [text, isError && !text ? error : ''].filter(Boolean).join('\n'), isError, error }
    }

    // -----------------------------------------------------------------------
    // Native-like transcript components (0.10.0).
    // Anatomy mirrors dsh-client-ui-chat / ui-tool: 16px leading box with a
    // 14px glyph, 24px disclosure rows, a 13px secondary summary, expandable
    // cards on the markdown code-block surface.
    // -----------------------------------------------------------------------

    /** Clipboard write with a document.execCommand fallback (no npm deps). */
    async function copyText(value) {
      const text = String(value ?? '')
      if (!text) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {}
      try {
        if (typeof document === 'undefined' || !document.body) return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /** Icon button that copies `text` and briefly shows the copied state. */
    function CopyButton({ text, label, t, className = 'sdc-iconbtn', showLabel = false }) {
      const [copied, setCopied] = useState(false)
      const timer = useRef(0)
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      const onClick = (event) => {
        event?.stopPropagation?.()
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1400)
        })
      }
      return h('button', {
        type: 'button',
        className,
        title: copied ? t('copied') : (label || t('copy')),
        'aria-label': copied ? t('copied') : (label || t('copy')),
        'data-copied': copied ? 'true' : undefined,
        onClick,
      }, h(copied ? IconCheck : IconCopy, null), showLabel ? h('span', null, copied ? t('copied') : (label || t('copy'))) : null)
    }

    // --- tiny inline icons (24x24 grid, 1.7 stroke, currentColor) ----------
    function iconBase(children, className, extra) {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        ...(className ? { className } : {}), ...(extra || {}),
      }, children)
    }
    function IconChevron(props) {
      return iconBase([h('path', { key: 'p', d: 'M6 9.5 12 15.5 18 9.5' })], props?.className)
    }
    function IconThink(props) {
      return iconBase([
        h('path', { key: 'a', d: 'M12 3.5 13.7 9.2 19.5 11 13.7 12.8 12 18.5 10.3 12.8 4.5 11 10.3 9.2Z' }),
      ], props?.className)
    }
    function IconTool(props) {
      const kind = props?.kind || 'other'
      const className = props?.className
      const paths = {
        read: [h('path', { key: 'a', d: 'M5 4.5h9.5L19 9v10.5H5Z' }), h('path', { key: 'b', d: 'M14 4.5V9h5' }), h('path', { key: 'c', d: 'M8 12.5h8M8 16h6' })],
        write: [h('path', { key: 'a', d: 'M4.5 19.5 5.6 15l9-9 3.4 3.4-9 9Z' }), h('path', { key: 'b', d: 'M13.4 6.6l3.4 3.4' })],
        edit: [h('path', { key: 'a', d: 'M4.5 19.5 5.6 15l9-9 3.4 3.4-9 9Z' }), h('path', { key: 'b', d: 'M13.4 6.6l3.4 3.4' })],
        grep: [h('circle', { key: 'a', cx: 10.5, cy: 10.5, r: 5.5 }), h('path', { key: 'b', d: 'M14.5 14.5 20 20' })],
        glob: [h('path', { key: 'a', d: 'M3.5 7.5h6l2 2h9v9.5h-17Z' }), h('path', { key: 'b', d: 'M3.5 7.5V5h6l2 2.5' })],
        command: [h('path', { key: 'a', d: 'M4.5 5.5h15v13h-15Z' }), h('path', { key: 'b', d: 'M7.5 9.5 10 12l-2.5 2.5M12.5 14.5h4' })],
        job: [h('circle', { key: 'a', cx: 12, cy: 12, r: 7.5 }), h('path', { key: 'b', d: 'M12 7.5V12l3 1.8' })],
        web: [h('circle', { key: 'a', cx: 12, cy: 12, r: 8 }), h('path', { key: 'b', d: 'M4 12h16M12 4c2.4 2.2 3.6 5 3.6 8s-1.2 5.8-3.6 8c-2.4-2.2-3.6-5-3.6-8s1.2-5.8 3.6-8Z' })],
        skill: [h('path', { key: 'a', d: 'M12 3.5 13.7 9.2 19.5 11 13.7 12.8 12 18.5 10.3 12.8 4.5 11 10.3 9.2Z' })],
        todo: [h('path', { key: 'a', d: 'M5 6.5l1.6 1.6L9.5 5M5 17.5l1.6 1.6L9.5 16' }), h('path', { key: 'b', d: 'M12 7.5h7M12 17.5h7' })],
        other: [h('path', { key: 'a', d: 'M14.5 6.5a4 4 0 0 0-5.4 5.2l-4.6 4.6 2.2 2.2 4.6-4.6a4 4 0 0 0 5.2-5.4l-2.3 2.3-2.2-2.2Z' })],
      }
      return iconBase(paths[kind] || paths.other, className)
    }
    function IconCopy(props) {
      return iconBase([
        h('rect', { key: 'a', x: 9, y: 9, width: 10.5, height: 10.5, rx: 2 }),
        h('path', { key: 'b', d: 'M6.5 14.5H5.2a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7h7.6a1.7 1.7 0 0 1 1.7 1.7v1.3' }),
      ], props?.className)
    }
    function IconCheck(props) {
      return iconBase([h('path', { key: 'a', d: 'M5 12.5 9.5 17 19 7.5' })], props?.className)
    }
    function IconArrowDown(props) {
      return iconBase([h('path', { key: 'a', d: 'M12 4.5v15M6.5 14 12 19.5 17.5 14' })], props?.className)
    }
    function IconStop(props) {
      return iconBase([h('rect', { key: 'a', x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.2, fill: 'currentColor', stroke: 'none' })], props?.className)
    }
    function IconSend(props) {
      return iconBase([h('path', { key: 'a', d: 'M12 19V5M6.5 10.5 12 5l5.5 5.5' })], props?.className)
    }
    function IconAlert(props) {
      return iconBase([h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }), h('path', { key: 'b', d: 'M12 7.5v5.5M12 16.2v.3' })], props?.className)
    }
    function IconShield(props) {
      return iconBase([
        h('path', { key: 'a', d: 'M12 3.5 19 6v5.2c0 4.6-3 7.7-7 9.3-4-1.6-7-4.7-7-9.3V6l7-2.5Z' }),
        h('path', { key: 'b', d: 'm9 12 2 2 4-4' }),
      ], props?.className)
    }
    function IconRefresh(props) {
      return iconBase([
        h('path', { key: 'a', d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }),
        h('path', { key: 'b', d: 'M19.5 4.5v4h-4' }),
      ], props?.className)
    }
    function IconEmpty(props) {
      return iconBase([
        h('path', { key: 'a', d: 'M4.5 6.5h15v9h-9l-4 4v-4h-2Z' }),
        h('path', { key: 'b', d: 'M8 11h8' }),
      ], props?.className)
    }
    function Spinner(props) {
      return h('svg', { className: props?.className || 'sdc-spin', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('circle', { className: 'sdc-spin-track', cx: 12, cy: 12, r: 9 }),
        h('circle', { className: 'sdc-spin-ring', cx: 12, cy: 12, r: 9 }),
        h('circle', { className: 'sdc-spin-arc', cx: 12, cy: 12, r: 9 }))
    }

    /** Fenced code block with a sticky language banner and a copy button. */
    function CodeBlock({ lang, code, t }) {
      return h('div', { className: 'sdc-codeblock' },
        h('div', { className: 'sdc-codebanner' },
          h('span', { className: 'sdc-codelang' }, lang || 'text'),
          h(CopyButton, { text: code, t, className: 'sdc-codecopy', showLabel: true })),
        h('pre', null, h('code', null, code)))
    }

    /** Unified diff with old/new line numbers and native add/remove colors. */
    function DiffBody({ diff, t }) {
      const lines = useMemo(() => {
        let oldNo = 1
        let newNo = 1
        return (diff?.rows || []).map((row) => {
          const entry = { kind: row.kind, text: row.text, oldNo: 0, newNo: 0 }
          if (row.kind === 'ctx') {
            entry.oldNo = oldNo
            entry.newNo = newNo
            oldNo += 1
            newNo += 1
          } else if (row.kind === 'del') {
            entry.oldNo = oldNo
            oldNo += 1
          } else {
            entry.newNo = newNo
            newNo += 1
          }
          return entry
        })
      }, [diff])
      return h('div', { className: 'sdc-diff', role: 'table', 'aria-label': t('toolEdit') },
        lines.map((line, index) => h('div', {
          key: index,
          className: 'sdc-diff-line',
          'data-kind': line.kind,
          role: 'row',
        },
          h('span', { className: 'sdc-diff-gutter' }, line.kind === 'del' ? String(line.oldNo) : line.kind === 'add' ? '' : String(line.oldNo)),
          h('span', { className: 'sdc-diff-gutter' }, line.kind === 'add' ? String(line.newNo) : line.kind === 'del' ? '' : String(line.newNo)),
          h('span', { className: 'sdc-diff-sign' }, line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '),
          h('span', { className: 'sdc-diff-text' }, line.text || ' '))),
        diff?.truncated ? h('span', { className: 'sdc-diff-more' }, `… ${diff.total} ${t('linesUnit')}`) : null)
    }

    /** Expanded tool body: edit diff, terminal, read, search, write or IO. */
    function ToolDetail({ model, t }) {
      if (model.kind === 'edit' && model.diff) {
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-card-head' },
              h('span', { className: 'sdc-card-lang' }, 'diff'),
              h('span', { className: 'sdc-card-title' }, model.path || t('toolEdit')),
              h(CopyButton, { text: (model.diff.rows || []).map((row) => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`).join('\n'), t })),
            h(DiffBody, { diff: model.diff, t })))
      }
      if (model.kind === 'command') {
        const command = model.command || { text: '', output: '', cwd: '' }
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-term' },
              h('div', { className: 'sdc-term-head' },
                h('span', { className: 'sdc-term-prompt' }, '$'),
                h('span', { className: 'sdc-term-cmd' }, command.text || '—'),
                model.exit && model.exit.failed
                  ? h('span', { className: 'sdc-exit' }, h('span', { className: 'sdc-exit-dot' }), model.exit.label)
                  : null,
                h(CopyButton, { text: command.text, t })),
              command.output
                ? h('pre', { className: 'sdc-term-out' }, command.output)
                : h('div', { className: 'sdc-card-body' }, t('toolEmptyOutput')))))
      }
      if (model.kind === 'read') {
        const read = model.read || { path: '', output: '', offset: null, limit: null }
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-card-head' },
              h('span', { className: 'sdc-card-title' }, read.path || t('toolRead')),
              read.offset !== null || read.limit !== null
                ? h('span', { className: 'sdc-card-lang' }, [read.offset, read.limit].filter((part) => part !== null && part !== undefined).join(':'))
                : null,
              h(CopyButton, { text: read.output, t })),
            h('pre', { className: 'sdc-code-pre' }, read.output || t('toolEmptyOutput'))))
      }
      if (model.kind === 'grep' || model.kind === 'glob') {
        const search = model.search || { pattern: '', output: '', matches: 0, files: 0 }
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-card-head' },
              h('span', { className: 'sdc-card-lang' }, model.kind),
              h('span', { className: 'sdc-card-title' }, search.pattern || (search.path || '')),
              h('span', { className: 'sdc-card-status' }, model.suffix),
              h(CopyButton, { text: search.output, t })),
            h('pre', { className: 'sdc-code-pre' }, search.output || t('toolEmptyOutput'))))
      }
      if (model.kind === 'write' && model.write) {
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-card-head' },
              h('span', { className: 'sdc-card-lang' }, 'write'),
              h('span', { className: 'sdc-card-title' }, model.write.path || t('toolWrite')),
              h(CopyButton, { text: model.write.content, t })),
            h('pre', { className: 'sdc-code-pre' }, model.write.content)))
      }
      if (model.kind === 'web' && model.web?.url) {
        return h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-card-head' },
              h('a', { className: 'sdc-card-title', href: model.web.url, target: '_blank', rel: 'noreferrer' }, model.web.url),
              h(CopyButton, { text: model.web.url, t })),
            model.output ? h('pre', { className: 'sdc-code-pre' }, model.output) : null))
      }
      const argsText = typeof model.args === 'object' && model.args
        ? JSON.stringify(model.args, null, 2)
        : (typeof model.args === 'string' ? model.args : '')
      return h('div', { className: 'sdc-detail' },
        h('div', { className: 'sdc-card' },
          argsText
            ? h('div', { className: 'sdc-io' },
              h('span', { className: 'sdc-io-label' }, t('toolArgs')),
              h('span', { className: 'sdc-io-text', style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12px' } }, argsText))
            : null,
          h('div', { className: 'sdc-io' },
            h('span', { className: 'sdc-io-label' }, t('toolOutput')),
            h('span', { className: 'sdc-io-text', 'data-error': model.state === 'error' ? 'true' : undefined }, model.output || (model.finished ? t('toolEmptyOutput') : t('commandRunning'))))))
    }

    /** One compact tool row with a native-like disclosure body. */
    function ToolDisclosure({ item, t }) {
      const row = item.row
      const [open, setOpen] = useState(false)
      const model = useMemo(() => toolRowModel(row, t), [row, t])
      const running = !model.finished
      const summary = model.kind === 'edit'
        ? String(row.summary || '').replace(/ · \+\d+ -\d+$/, '')
        : (model.kind === 'command'
          ? (model.command?.text || row.summary || '')
          : (row.summary || model.path || ''))
      const duration = !running && Number(row.durationMs) > 0 ? formatDuration(row.durationMs) : ''
      return h('div', { className: 'sdc-rowbody' },
        h('button', {
          type: 'button',
          className: 'sdc-row',
          'data-state': model.state,
          'data-running': running ? 'true' : undefined,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
          running ? h(Spinner, { className: 'sdc-lead sdc-spin' }) : h(IconTool, { kind: model.kind === 'command' ? 'command' : model.kind === 'todo' ? 'todo' : model.kind, className: 'sdc-lead' }),
          h('span', { className: 'sdc-title' }, toolKindLabel(model.kind, t)),
          summary ? h('span', { className: 'sdc-sep' }) : null,
          summary ? h('span', { className: `sdc-sum${model.kind === 'command' || model.kind === 'edit' || model.kind === 'read' ? ' sdc-sum-code' : ''}`, title: summary }, summary) : null,
          model.diffStat
            ? h('span', { className: 'sdc-suffix sdc-suffix-code' },
              h('span', { className: 'sdc-suffix-add' }, `+${model.diffStat.added}`),
              ' ',
              h('span', { className: 'sdc-suffix-del' }, `-${model.diffStat.removed}`))
            : null,
          model.exit && model.exit.failed
            ? h('span', { className: 'sdc-exit' }, h('span', { className: 'sdc-exit-dot' }), model.exit.label)
            : (model.suffix && !running ? h('span', { className: 'sdc-suffix' }, model.suffix) : null),
          duration ? h('span', { className: 'sdc-suffix' }, duration) : (running ? h('span', { className: 'sdc-suffix' }, t('rowRunning')) : null),
          h(IconChevron, { className: 'sdc-chevron' })),
        open ? h(ToolDetail, { model, t }) : null)
    }

    /** Command lifecycle row (runtime `command/run` + `command/done`). */
    function CommandDisclosure({ item, t }) {
      const row = item.row
      const [open, setOpen] = useState(false)
      const running = !row.done
      const name = row.name || t('toolCommand')
      const commandText = [name, row.args].filter(Boolean).join(' ')
      const exit = exitCodeOf(row.output, row.failed === true)
      return h('div', { className: 'sdc-rowbody' },
        h('button', {
          type: 'button',
          className: 'sdc-row',
          'data-running': running ? 'true' : undefined,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
          running ? h(Spinner, { className: 'sdc-lead sdc-spin' }) : h(IconTool, { kind: 'command', className: 'sdc-lead' }),
          h('span', { className: 'sdc-title' }, t('toolCommand')),
          commandText ? h('span', { className: 'sdc-sep' }) : null,
          commandText ? h('span', { className: 'sdc-sum sdc-sum-code' }, commandText) : null,
          exit && exit.failed && !running ? h('span', { className: 'sdc-exit' }, h('span', { className: 'sdc-exit-dot' }), exit.label) : null,
          h(IconChevron, { className: 'sdc-chevron' })),
        open ? h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('div', { className: 'sdc-term' },
              h('div', { className: 'sdc-term-head' },
                h('span', { className: 'sdc-term-prompt' }, '$'),
                h('span', { className: 'sdc-term-cmd' }, commandText),
                h(CopyButton, { text: commandText, t })),
              row.output
                ? h('pre', { className: 'sdc-term-out' }, row.output)
                : h('div', { className: 'sdc-card-body' }, running ? t('commandRunning') : t('toolEmptyOutput'))))) : null)
    }

    /** Background job row: status dot, label, duration, expandable facts. */
    function JobDisclosure({ item, t }) {
      const job = item.row
      const [open, setOpen] = useState(false)
      const settled = Boolean(job.finishedAt)
      const failed = job.failed === true || job.status === 'failed' || job.status === 'error' || job.status === 'cancelled'
      const startedAt = Number(job.startedAt) || 0
      const finishedAt = Number(job.finishedAt) || 0
      const duration = settled && startedAt && finishedAt > startedAt ? formatDuration(finishedAt - startedAt) : ''
      const label = job.label || job.jobId || t('jobTitle')
      const meta = {
        jobId: job.jobId, kind: job.kind, label: job.label, status: job.status,
        cause: job.cause, detail: job.detail, startedAt: job.startedAt, finishedAt: job.finishedAt,
      }
      return h('div', { className: 'sdc-rowbody' },
        h('button', {
          type: 'button',
          className: 'sdc-row',
          'data-running': settled ? undefined : 'true',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
          settled ? h(IconTool, { kind: 'job', className: 'sdc-lead' }) : h(Spinner, { className: 'sdc-lead sdc-spin' }),
          h('span', { className: 'sdc-title' }, t('jobTitle')),
          h('span', { className: 'sdc-sep' }),
          h('span', { className: 'sdc-sum sdc-sum-code' }, label),
          h('span', { className: 'sdc-suffix' }, failed ? t('jobFailed') : settled ? t('jobSettled') : t('jobRunning')),
          duration ? h('span', { className: 'sdc-suffix' }, duration) : null,
          h(IconChevron, { className: 'sdc-chevron' })),
        open ? h('div', { className: 'sdc-detail' },
          h('div', { className: 'sdc-card' },
            h('dl', { className: 'sdc-job-meta' },
              h('dt', null, 'jobId'), h('dd', null, String(job.jobId || '—')),
              h('dt', null, 'kind'), h('dd', null, String(job.kind || '—')),
              h('dt', null, 'status'), h('dd', null, String(job.status || (settled ? 'settled' : 'running'))),
              job.detail ? h('dt', null, 'detail') : null,
              job.detail ? h('dd', null, String(job.detail)) : null),
            h('pre', { className: 'sdc-code-pre', style: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' } }, JSON.stringify(meta, null, 2)))) : null)
    }

    /** Todo checklist card (latest `todo/write` of the turn). */
    function TodoCard({ todos, t }) {
      const done = todos.filter((todo) => todo.status === 'completed').length
      return h('div', { className: 'sdc-detail' },
        h('div', { className: 'sdc-card' },
          h('div', { className: 'sdc-card-head' },
            h(IconTool, { kind: 'todo', className: 'sdc-card-lang' }),
            h('span', { className: 'sdc-card-title' }, t('todoTitle')),
            h('span', { className: 'sdc-card-status' }, `${done}/${todos.length}`)),
          h('div', { className: 'sdc-todo' }, todos.map((todo, index) => {
            const state = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'todo'
            return h('div', { key: index, className: 'sdc-todo-item', 'data-state': state },
              h('span', { className: 'sdc-todo-mark' }, state === 'done'
                ? h(IconCheck, null)
                : state === 'active' ? h('span', { className: 'sdw-dot run' }) : h('span', { className: 'sdw-dot' })),
              h('span', { className: 'sdc-todo-text' }, todo.content || ''))
          }))))
    }

    /** One-line context chip (model / sandbox / permission / cwd / approval). */
    function ChipRow({ item, t }) {
      const value = item.valueKey ? t(item.value) : item.value
      return h('div', { className: 'sdc-chip-row' },
        h('span', { className: 'sdc-chip-label' }, `${t(item.labelKey)} ·`),
        h('span', { className: 'sdc-chip-value', title: value }, value))
    }

    /** Collapsed-by-default reasoning row; auto-expands while streaming. */
    function ReasoningRow({ item, t }) {
      const streaming = item.streaming === true
      const [open, setOpen] = useState(streaming)
      useEffect(() => { setOpen(streaming) }, [streaming])
      const summary = firstLine(item.text, 96)
      const duration = !streaming && Number(item.durationMs) > 0 ? formatDuration(item.durationMs) : ''
      return h('div', { className: 'sdc-reason' },
        h('button', {
          type: 'button',
          className: 'sdc-row',
          'data-streaming': streaming ? 'true' : undefined,
          'data-running': streaming ? 'true' : undefined,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
          h(IconThink, { className: 'sdc-lead' }),
          h('span', { className: 'sdc-title' }, t('thinkTitle')),
          !open && summary ? h('span', { className: 'sdc-sep' }) : null,
          !open && summary ? h('span', { className: 'sdc-sum' }, summary) : null,
          streaming ? h('span', { className: 'sdc-suffix' }, t('thinkRunning')) : duration ? h('span', { className: 'sdc-suffix' }, duration) : null,
          h(IconChevron, { className: 'sdc-chevron' })),
        open
          ? h('div', { className: `sdc-reason-body${streaming ? ' sdc-reason-stream' : ''}` },
            h(Markdown, { text: item.text, streaming, compact: true, t }))
          : null)
    }

    /** Process block header: collapsed when completed, open while running. */
    function ProcessGroup({ block, t }) {
      const stats = useMemo(() => processStats(block), [block])
      const [open, setOpen] = useState(stats.running)
      useEffect(() => {
        setOpen(stats.running)
      }, [stats.running])
      const parts = []
      if (stats.running) parts.push(t('processRunning'))
      else parts.push(t('processDone'))
      if (stats.reasoningMs > 0) parts.push(`${t('processThought')} ${formatDuration(stats.reasoningMs)}`)
      if (stats.tools > 0) parts.push(`${stats.tools} ${t('toolCallsUnit')}`)
      if (stats.commands > 0) parts.push(`${stats.commands} ${t('commandsUnit')}`)
      if (stats.jobs > 0) parts.push(`${stats.jobs} ${t('jobsUnit')}`)
      if (stats.errors > 0) parts.push(`${stats.errors} ${t('errorsUnit')}`)
      return h('div', { className: 'sdc-process', 'data-kind': 'process', 'data-open': open ? 'true' : undefined },
        h('button', {
          type: 'button',
          className: 'sdc-row sdc-process-head',
          'aria-expanded': open ? 'true' : 'false',
          'data-running': stats.running ? 'true' : undefined,
          onClick: () => setOpen((value) => !value),
        },
          stats.running ? h(Spinner, { className: 'sdc-lead sdc-spin' }) : h(IconThink, { className: 'sdc-lead' }),
          h('span', { className: 'sdc-title' }, parts.join(' · ')),
          open ? null : h('span', { className: 'sdc-sum' }),
          h(IconChevron, { className: 'sdc-chevron' })),
        open
          ? h('div', { className: 'sdc-process-body' }, block.items.map((item) => {
            switch (item.kind) {
              case 'reasoning': return h(ReasoningRow, { key: item.key, item, t })
              case 'tool': return h(ToolDisclosure, { key: item.key, item, t })
              case 'command': return h(CommandDisclosure, { key: item.key, item, t })
              case 'job': return h(JobDisclosure, { key: item.key, item, t })
              case 'todo': return h(TodoCard, { key: item.key, todos: item.todos, t })
              case 'chip': return h(ChipRow, { key: item.key, item, t })
              case 'error': return h('div', { key: item.key, className: 'sdc-error-row' },
                h(IconAlert, null), h('span', { className: 'sdc-error-text' }, item.text))
              default: return null
            }
          }))
          : null)
    }

    /** Right-aligned user bubble + relative time, like the native chat. */
    function UserRow({ user, t }) {
      return h('div', { className: 'sdc-user', 'data-kind': 'user' },
        h('div', { className: 'sdc-user-stack' },
          h('div', { className: 'sdc-bubble' }, user.text)),
        h('div', { className: 'sdc-user-meta' }, relativeTime(user.at)))
    }

    /** Assistant reply (markdown) with an optional streaming caret. */
    function ResponseBlock({ block, t }) {
      return h('div', { className: 'sdc-response', 'data-kind': 'response' }, h(Markdown, { text: block.text, streaming: block.streaming === true, t }))
    }

    /** Turn footer: time + copy-reply action (hover/focus revealed). */
    function TurnTail({ turn, text, latest, t }) {
      const last = turn.tail?.at || turn.at
      const duration = turn.at && last > turn.at ? formatDuration(last - turn.at) : ''
      return h('div', { className: 'sdc-tail', 'data-kind': 'tail', 'data-latest': latest ? 'true' : undefined },
        h('span', { className: 'sdc-tail-meta' },
          [relativeTime(last), duration ? `${t('usedTime')} ${duration}` : '', turn.interrupted ? t('statusStopped') : ''].filter(Boolean).join(' · ')),
        text
          ? h('span', { className: 'sdc-tail-actions' }, h(CopyButton, { text, label: t('copyMessage'), t, className: 'sdc-act' }))
          : null)
    }

    /** One turn: user row, process/reply blocks, footer. */
    function TurnView({ turn, t, latest }) {
      const nodes = []
      if (turn.user && turn.user.text) nodes.push(h(UserRow, { key: `${turn.key}-user`, user: turn.user, t }))
      for (const block of turn.blocks) {
        nodes.push(block.kind === 'process'
          ? h(ProcessGroup, { key: block.key, block, t })
          : h(ResponseBlock, { key: block.key || `${turn.key}-resp`, block, t }))
      }
      const lastResponse = [...turn.blocks].reverse().find((block) => block.kind === 'response')
      if (turn.tail || lastResponse) {
        nodes.push(h(TurnTail, { key: `${turn.key}-tail`, turn, text: lastResponse?.text || '', latest, t }))
      }
      return h('div', { className: 'sdc-turn', 'data-turn': turn.key }, nodes)
    }

    /** Running indicator used while the turn produced no visible content yet. */
    function RunningRow({ t }) {
      return h('div', { className: 'sdc-running' }, h(Spinner, { className: 'sdc-spin' }), h('span', { className: 'sdc-running-text' }, t('thinking')))
    }

    function ChatSkeleton({ t }) {
      return h('div', { className: 'sdc-skeleton', 'aria-busy': 'true', 'aria-label': t('loadingHistory') },
        h('div', { className: 'sdc-sk-row' }, h('div', { className: 'sdc-sk-bar', style: { width: '38%' } })),
        h('div', { className: 'sdc-sk-row' }, h('div', { className: 'sdc-sk-bar', style: { width: '72%' } })),
        h('div', { className: 'sdc-sk-row' }, h('div', { className: 'sdc-sk-bar', style: { width: '56%' } })),
        h('div', { className: 'sdc-sk-row' },
          h('div', { className: 'sdc-sk-bar', style: { width: '16px', height: '16px', borderRadius: '50%' } }),
          h('div', { className: 'sdc-sk-bar', style: { width: '44%' } })),
        h('div', { className: 'sdc-sk-row' }, h('div', { className: 'sdc-sk-bar', style: { width: '64%' } })))
    }

    function ChatEmpty({ t }) {
      return h('div', { className: 'sdc-empty' },
        h(IconEmpty, { className: 'sdc-empty-icon' }),
        h('div', { className: 'sdc-empty-title' }, t('emptyTitle')),
        h('div', { className: 'sdc-empty-hint' }, t('emptyHint')))
    }

    /** Human-readable approval reason; older bridges may send JSON `{zh,en}`. */
    function approvalReasonText(approval) {
      const raw = approval?.displayReason ?? approval?.reason ?? ''
      if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(raw)
          const text = parsed.zh || parsed.en || parsed.text || parsed.message
          if (typeof text === 'string' && text.trim()) return text
        } catch {}
      }
      if (raw && typeof raw === 'object') {
        const text = raw.zh || raw.en || raw.text || raw.message
        if (typeof text === 'string' && text.trim()) return text
        try { return JSON.stringify(raw) } catch { return String(raw) }
      }
      return String(raw || '')
    }

    // -----------------------------------------------------------------------
    // Interactive user questions / plan review (0.8.0). Pure helpers are
    // exposed to tests through __shadowTesting.
    // -----------------------------------------------------------------------

    const PLAN_REVIEW_KIND = 'plan-review'

    /** Normalize one asked question (service vocabulary + model spellings). */
    function normalizeQuestion(item) {
      if (!item || typeof item !== 'object') return null
      const id = String(item.id ?? '')
      const title = String(item.question ?? item.title ?? '')
      if (!id || !title.trim()) return null
      const options = (Array.isArray(item.options) ? item.options : [])
        .map((option) => ({
          label: String(option?.label ?? ''),
          ...(typeof option?.description === 'string' ? { description: option.description } : {}),
        }))
        .filter((option) => option.label)
      const intent = item.intent && typeof item.intent === 'object' && typeof item.intent.kind === 'string'
        ? {
          kind: item.intent.kind,
          ...(item.intent.approve ? { approve: String(item.intent.approve) } : {}),
          ...(item.intent.detail ? { detail: String(item.intent.detail) } : {}),
        }
        : null
      return {
        id,
        title: title.trim(),
        ...(item.header ? { header: String(item.header) } : {}),
        ...(item.detail ? { detail: String(item.detail) } : {}),
        options,
        multiSelect: item.multiSelect === true || item.multi === true,
        ...(intent ? { intent } : {}),
      }
    }

    /** Normalize one pending-question request from a batch or transient frame. */
    function normalizeQuestionRequest(value) {
      if (!value || typeof value !== 'object') return null
      const questionId = String(value.questionId ?? '')
      const questions = (Array.isArray(value.questions) ? value.questions : [])
        .map(normalizeQuestion)
        .filter(Boolean)
      if (!questionId || questions.length === 0) return null
      const intent = value.intent && typeof value.intent === 'object'
        ? value.intent
        : (questions.find((question) => question.intent)?.intent || null)
      return {
        questionId,
        sessionId: String(value.sessionId ?? ''),
        questions,
        intent,
        planReview: Boolean(intent && intent.kind === PLAN_REVIEW_KIND),
        createdAt: Number(value.createdAt) || 0,
        expiresAt: Number(value.expiresAt) || 0,
        ttlMs: Number(value.ttlMs) || 0,
      }
    }

    /** Plan-review facts of one request, or null for generic questions. */
    function planReviewOf(request) {
      if (!request || request.planReview !== true) return null
      const question = request.questions.find((item) => item.intent?.kind === PLAN_REVIEW_KIND) || request.questions[0]
      if (!question) return null
      const intent = question.intent || request.intent || {}
      return {
        question,
        title: question.header || question.title,
        detail: String(intent.detail || question.detail || ''),
        approve: String(intent.approve || ''),
      }
    }

    /** Two plain-text summary lines of a plan document. */
    function planReviewSummary(detail, lines = 2) {
      return String(detail ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .filter(Boolean)
        .slice(0, lines)
        .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line))
        .join(' / ')
    }

    /** Empty per-question draft state. */
    function blankQuestionDrafts(request) {
      const drafts = {}
      for (const question of request.questions || []) {
        drafts[question.id] = { selected: [], custom: '', skipped: false }
      }
      return drafts
    }

    /** Questions that would be submitted unanswered. */
    function questionAnswerErrors(request, drafts) {
      const errors = []
      for (const question of request.questions || []) {
        const draft = drafts[question.id] || { selected: [], custom: '', skipped: false }
        if (draft.skipped) continue
        const custom = String(draft.custom || '').trim()
        const selected = Array.isArray(draft.selected) ? draft.selected : []
        if (!custom && selected.length === 0) errors.push(question.title)
      }
      return errors
    }

    /** Build the wire answer batch (`{id, selected, custom?}` per question). */
    function buildQuestionAnswers(request, drafts) {
      return (request.questions || []).map((question) => {
        const draft = drafts[question.id] || { selected: [], custom: '', skipped: false }
        if (draft.skipped) return { id: question.id, selected: [] }
        const custom = String(draft.custom || '').trim()
        const selected = Array.isArray(draft.selected) ? draft.selected.filter(Boolean) : []
        if (question.multiSelect) {
          return { id: question.id, selected, ...(custom ? { custom } : {}) }
        }
        if (custom) return { id: question.id, selected: [], custom }
        return { id: question.id, selected: selected.slice(0, 1) }
      })
    }

    /** Answer batch that approves a plan-review question. */
    function approvePlanAnswers(request, plan) {
      const target = plan?.question?.id || request.questions[0]?.id || ''
      return (request.questions || []).map((question) => ({
        id: question.id,
        selected: question.id === target && plan?.approve ? [plan.approve] : [],
      }))
    }

    /** Human-readable lines of a recorded answer batch. */
    function questionAnswerLines(request, answers) {
      const byId = new Map((Array.isArray(answers) ? answers : []).map((answer) => [String(answer?.id ?? ''), answer]))
      return (request.questions || []).map((question) => {
        const answer = byId.get(question.id) || { selected: [] }
        const selected = Array.isArray(answer.selected) ? answer.selected.map(String) : []
        const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
        const parts = []
        if (selected.length > 0) parts.push(selected.join('、'))
        if (custom) parts.push(custom)
        return {
          id: question.id,
          title: question.title,
          text: parts.length > 0 ? parts.join(' · ') : '',
          skipped: parts.length === 0,
        }
      })
    }

    function QuestionCard({ request, busy, disabled, onSubmit, onCancelQuestion, t }) {
      const [drafts, setDrafts] = useState(() => blankQuestionDrafts(request))
      const [errors, setErrors] = useState([])
      const plan = planReviewOf(request)

      useEffect(() => {
        setDrafts(blankQuestionDrafts(request))
        setErrors([])
      }, [request.questionId])

      const update = (questionId, patch) => setDrafts((prev) => ({
        ...prev,
        [questionId]: { ...(prev[questionId] || { selected: [], custom: '', skipped: false }), ...patch },
      }))

      if (plan) {
        return h(PlanReviewCard, {
          request,
          plan,
          busy,
          disabled,
          t,
          onApprove: () => onSubmit(approvePlanAnswers(request, plan)),
          onModify: () => onCancelQuestion(request),
        })
      }

      const submit = () => {
        const nextErrors = questionAnswerErrors(request, drafts)
        setErrors(nextErrors)
        if (nextErrors.length > 0) return
        onSubmit(buildQuestionAnswers(request, drafts))
      }

      return h('div', { className: 'sdc-attention' },
        h('div', { className: 'sdc-attention-strip' },
          h('span', { className: 'sdw-dot warn' }),
          h('span', { style: { flex: 1, minWidth: 0 } }, request.questions[0]?.header || t('questionTitle')),
          h('span', { style: { flex: 'none', opacity: .8 } }, `${request.questions.length}`)),
        h('div', { className: 'sdc-attention-body sdc-question' }, request.questions.map((question, index) => {
          const draft = drafts[question.id] || { selected: [], custom: '', skipped: false }
          return h('div', { key: question.id, className: 'sdc-question-item' },
            h('p', { className: 'sdc-question-q' }, `${index + 1}. ${question.title}`),
            question.detail
              ? h('details', { className: 'sdc-question-detail' },
                h('summary', null, t('questionDetail')),
                h('div', null, h(Markdown, { text: question.detail, compact: true, t })))
              : null,
            question.options.length > 0
              ? h('div', { className: 'sdc-question-options' }, question.options.map((option, optionIndex) => {
                const active = draft.selected.includes(option.label)
                return h('button', {
                  key: option.label,
                  type: 'button',
                  className: 'sdc-question-option',
                  'data-active': active ? 'true' : undefined,
                  disabled: disabled || busy,
                  onClick: () => update(question.id, {
                    skipped: false,
                    selected: question.multiSelect
                      ? (active ? draft.selected.filter((label) => label !== option.label) : [...draft.selected, option.label])
                      : (active ? [] : [option.label]),
                  }),
                },
                  h('span', { className: 'sdc-question-mark' }, active ? h(IconCheck, null) : String(optionIndex + 1)),
                  h('span', { className: 'sdc-question-opt' },
                    h('span', { className: 'sdc-question-label' }, option.label),
                    option.description ? h('span', { className: 'sdc-question-desc' }, option.description) : null))
              }))
              : null,
            h('input', {
              className: 'sdc-question-input',
              value: draft.custom,
              placeholder: t('questionCustom'),
              disabled: disabled || busy,
              onChange: (event) => update(question.id, { skipped: false, custom: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              },
            }),
            h('label', { className: 'sdc-question-skip' },
              h('input', {
                type: 'checkbox',
                checked: draft.skipped === true,
                disabled: disabled || busy,
                onChange: (event) => update(question.id, { skipped: event.target.checked }),
              }),
              t('questionSkip')))
        })),
        h('div', { className: 'sdc-attention-actions' },
          errors.length > 0
            ? h('div', { className: 'sdc-question-error', style: { textAlign: 'left' } }, `${t('questionMissing')}: ${errors.join(' / ')}`)
            : h('span', { style: { flex: 1 } }),
          h('button', {
            className: 'sdc-cardbtn',
            disabled: disabled || busy,
            onClick: () => onSubmit(request.questions.map((question) => ({ id: question.id, selected: [] }))),
          }, t('questionSkipAll')),
          h('button', { className: 'sdc-cardbtn', 'data-variant': 'primary', disabled: disabled || busy, onClick: submit },
            busy ? t('sending') : t('questionSubmit'))))
    }

    function PlanReviewCard({ request, plan, busy, disabled, onApprove, onModify, t }) {
      const [open, setOpen] = useState(false)
      return h('div', { className: 'sdc-attention' },
        h('div', { className: 'sdc-attention-strip' },
          h('span', { className: 'sdw-dot warn' }),
          h('span', { style: { flex: 1, minWidth: 0 } }, t('planReviewTitle')),
          h('button', {
            type: 'button',
            className: 'sdc-plan-link',
            disabled: disabled || busy,
            onClick: () => setOpen((prev) => !prev),
          }, open ? t('planCollapse') : t('planViewFull'))),
        h('div', { className: 'sdc-plan' },
          h('div', { className: 'sdc-plan-summary' },
            h('h3', { className: 'sdc-plan-title' }, plan.title),
            h('p', { className: 'sdc-plan-desc' }, planReviewSummary(plan.detail) || plan.question.title)),
          open ? h('div', { className: 'sdc-plan-detail' }, h(Markdown, { text: plan.detail, compact: true, t })) : null),
        h('div', { className: 'sdc-attention-actions' },
          h('button', { className: 'sdc-cardbtn', disabled: disabled || busy, onClick: onModify }, t('planRequestChanges')),
          h('button', { className: 'sdc-cardbtn', 'data-variant': 'primary', disabled: disabled || busy, onClick: onApprove },
            busy ? t('sending') : t('planApprove'))))
    }

    // 0.10.25: the answered question is a durable `ask_user_question` row in the
    // transcript (native has no "已回答" card above the composer), so the old
    // pinned `QuestionAnsweredCard` was removed with the `answeredQuestions`
    // state. Approvals still keep their card because they are transient-only.

    function ApprovalCard({ approval, busy, onAnswer, t }) {
      const reason = approvalReasonText(approval)
      return h('div', { className: 'sdc-attention' },
        h('div', { className: 'sdc-attention-strip' },
          h('span', { className: 'sdw-dot warn' }),
          h('span', { style: { flex: 1, minWidth: 0 } }, t('approvals')),
          approval.toolName ? h('span', { style: { flex: 'none', opacity: .85, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '12px' } }, approval.toolName) : null),
        h('div', { className: 'sdc-attention-body' },
          h('p', { className: 'sdc-attention-title' }, reason || t('approvalEvent')),
          approval.callId ? h('div', { className: 'sdc-attention-command' }, `callId: ${approval.callId}`) : null),
        h('div', { className: 'sdc-attention-actions' },
          h('button', { className: 'sdc-cardbtn', 'data-variant': 'danger', disabled: busy, onClick: () => onAnswer(approval, 'rejected') }, t('reject')),
          h('button', { className: 'sdc-cardbtn', 'data-variant': 'primary', disabled: busy, onClick: () => onAnswer(approval, 'allowed-once') }, t('approve'))))
    }



    // -----------------------------------------------------------------------
    // Chunked file transfer (0.9.0, pure helpers + push control)
    // -----------------------------------------------------------------------

    /** Human byte size (`1.5 MB`). */
    function formatFileSize(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB']
      let size = value
      let unit = -1
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 || Number.isInteger(size) ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    /** Base64 of one byte array, built in slices (no huge spread arguments). */
    function bytesToBase64(bytes) {
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000))
      }
      return btoa(binary)
    }

    /**
     * Split one buffer into base64 chunks. Pure: exposed for the unit tests.
     * @param {ArrayBuffer|Uint8Array} buffer - file bytes.
     * @param {number} chunkBytes - raw bytes per chunk.
     * @returns {string[]} base64 chunks.
     */
    function uploadChunksOf(buffer, chunkBytes) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
      const size = Math.max(1, Number(chunkBytes) || 512 * 1024)
      const chunks = []
      for (let offset = 0; offset < bytes.length; offset += size) {
        chunks.push(bytesToBase64(bytes.subarray(offset, Math.min(bytes.length, offset + size))))
      }
      return chunks
    }

    // -----------------------------------------------------------------------
    // Shadow composer controls (0.10.25): permission preset labels, attachment
    // classification, the answered-question row model and the voice WAV
    // pipeline. Pure helpers so the node tests and the headless harness can
    // exercise them without a browser.
    // -----------------------------------------------------------------------

    /** Native permission-preset identities → local dictionary keys. */
    const PERMISSION_LABEL_KEYS = {
      'read-only': 'permReadonly',
      'workspace-write': 'permWorkspace',
      'danger-full-access': 'permFull',
      auto: 'permAuto',
    }

    /** Presets whose selection needs the native-style risk confirmation. */
    const PERMISSION_RISK_VALUES = new Set(['danger-full-access', 'auto'])

    /**
     * Localized label for one preset value; host-custom presets keep their name
     * (title-cased) like the native client does.
     * @param {string} value - preset value.
     * @param {(key: string) => string} t - translator.
     * @returns {string} display label.
     */
    function permissionLabelOf(value, t) {
      const name = String(value || '')
      if (!name) return ''
      if (name === 'custom') return t('permCustom')
      const key = PERMISSION_LABEL_KEYS[name]
      if (key) return t(key)
      return name.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
    }

    /** Image files are inlined by the Host; everything else becomes a file receipt. */
    function attachmentKindOf(file) {
      const type = String(file?.type || '').toLowerCase()
      return type.startsWith('image/') ? 'image' : 'file'
    }

    /** Parse `ask_user_question` tool args/results into a native-like row model. */
    function questionRowModel(row, t = (key) => key) {
      const source = row || {}
      const parse = (value) => {
        if (value === undefined || value === null || typeof value !== 'string') return value
        try { return JSON.parse(value) } catch { return null }
      }
      const args = parse(source.args)
      const questions = Array.isArray(args?.questions) ? args.questions : []
      const result = parse(source.result)
      const answers = Array.isArray(result?.answers) ? result.answers : null
      const answerOf = (question) => {
        const answer = answers?.find((entry) => String(entry?.id) === String(question?.id))
        const parts = []
        if (answer && Array.isArray(answer.selected)) {
          for (const value of answer.selected) {
            if (String(value ?? '').trim()) parts.push(String(value))
          }
        }
        if (answer && typeof answer.custom === 'string' && answer.custom.trim()) parts.push(answer.custom.trim())
        return parts.join(' · ')
      }
      const pairs = questions.map((question, index) => ({
        key: `${index}-${String(question?.id ?? index)}`,
        title: String(question?.header || question?.question || question?.id || ''),
        answer: answerOf(question),
      }))
      const total = pairs.length
      const answered = pairs.filter((pair) => pair.answer).length
      const pending = answers === null
      return {
        total,
        answered,
        pending,
        pairs,
        summary: pending
          ? t('questionWaiting')
          : total > 0 ? `${answered}/${total} ${t('questionAnswered')}` : t('questionAnswered'),
      }
    }

    /** mm:ss for the recording bar. */
    function clockText(seconds) {
      const value = Math.max(0, Math.floor(Number(seconds) || 0))
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    }

    /**
     * Encode mono Float32 samples as a 16 kHz / 16-bit PCM WAV (native's
     * `encodeWave`: 44-byte header, clamp then scale).
     * @param {Float32Array} samples - mono samples at 16 kHz.
     * @returns {Uint8Array} WAV bytes.
     */
    function encodeWav16k(samples) {
      const length = samples.length
      const bytes = new Uint8Array(44 + length * 2)
      const view = new DataView(bytes.buffer)
      const write = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + length * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, length * 2, true)
      for (let index = 0; index < length; index += 1) {
        const sample = Math.max(-1, Math.min(1, Number(samples[index]) || 0))
        view.setInt16(44 + index * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
      }
      return bytes
    }

    /**
     * Resample one decoded recording to mono 16 kHz and return WAV bytes,
     * mirroring the native voice input client (OfflineAudioContext).
     * @param {AudioBuffer} decoded - decoded recording.
     * @param {number} maxSeconds - hard duration cap (native: 120 s).
     * @returns {Promise<Uint8Array>} WAV bytes.
     */
    async function resampleToWav16k(decoded, maxSeconds = 120) {
      const limit = Math.max(0.05, Number(maxSeconds) || 120)
      const seconds = Math.min(Math.max(0, Number(decoded?.duration) || 0), limit)
      const length = Math.max(1, Math.floor(seconds * 16000))
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
      if (!Offline) throw new Error('OfflineAudioContext is unavailable')
      const offline = new Offline(1, length, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return encodeWav16k(rendered.getChannelData(0))
    }

    /** Lowercase hex sha256 of one buffer through WebCrypto. */
    async function sha256HexOf(buffer) {
      const subtle = typeof crypto !== 'undefined' ? crypto.subtle : null
      if (!subtle || typeof subtle.digest !== 'function') {
        throw new Error('WebCrypto SHA-256 is unavailable in this browser')
      }
      const digest = await subtle.digest('SHA-256', buffer)
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    }

    /**
     * Push one local `File` to the selected peer: begin -> sequential chunks ->
     * commit. `push(payload)` is the local `push-file` data-route call (which
     * forwards each step as `ext.shadow.push-file`); on any failure the transfer
     * is aborted on the peer.
     * @param {{push: (payload: object) => Promise<object>, file: {name?: string, arrayBuffer: () => Promise<ArrayBuffer>}, chunkBytes?: number, onProgress?: (progress: object) => void}} input - push input.
     * @returns {Promise<{transferId: string, name: string, size: number, sha256: string, chunks: number}>} commit facts.
     */
    async function pushLocalFile({ push, file, chunkBytes, onProgress }) {
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('a File is required')
      const buffer = await file.arrayBuffer()
      const size = buffer.byteLength
      const sha256 = await sha256HexOf(buffer)
      const transferId = `shadow-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const name = String(file.name || 'file')
      let started = false
      try {
        // `action` mirrors `step` for callers/tests speaking the pre-0.9.0
        // payload shape; the data route prefers `step` and keeps its own
        // route action ('push-file') under `action`.
        const begin = await push({ action: 'begin', step: 'begin', transferId, name, size, sha256 })
        started = true
        const negotiated = Number(begin?.chunkBytes)
        const effective = Math.max(1, Math.min(
          Number(chunkBytes) || 512 * 1024,
          Number.isFinite(negotiated) && negotiated > 0 ? negotiated : 512 * 1024,
        ))
        const chunks = uploadChunksOf(buffer, effective)
        onProgress?.({ sent: 0, total: chunks.length, size })
        for (let index = 0; index < chunks.length; index += 1) {
          await push({ action: 'chunk', step: 'chunk', transferId, index, data: chunks[index] })
          onProgress?.({ sent: index + 1, total: chunks.length, size })
        }
        const commit = await push({ action: 'commit', step: 'commit', transferId, sha256 })
        return {
          transferId,
          name: String(commit?.name || name),
          size: Number(commit?.size ?? size),
          sha256: String(commit?.sha256 || sha256),
          chunks: chunks.length,
        }
      } catch (error) {
        if (started) {
          try { await push({ action: 'abort', step: 'abort', transferId }) } catch {}
        }
        throw error
      }
    }

    /**
     * Settings card: push one local file to the selected peer. Rendered only
     * when a peer is selected AND that peer accepts files (0.9.0).
     */
    function PushFileCard({ panel, t, busy, push, onPush }) {
      const [file, setFile] = useState(null)
      const uploads = panel?.uploads || {}
      const peerUploads = uploads.peer || {}
      const hasPeer = Boolean(panel?.display?.peerDeviceId)
      const ready = peerUploads.enabled === true
      // Requirement: only visible when a peer is selected and uploads enabled.
      if (!hasPeer || !ready) return null
      const limit = Number(peerUploads.maxBytes) || 0
      const sending = push?.status === 'sending'
      const progress = Number.isFinite(push?.sent) && Number.isFinite(push?.total) && push.total > 0
        ? Math.min(100, Math.round((push.sent / push.total) * 100))
        : 0
      return h('section', { className: 'sdw-card' },
        h('div', { className: 'sdw-card-head' },
          h('span', { className: 'sdw-dot on' }),
          h('div', { className: 'sdw-card-title' }, t('uploadsTitle')),
          limit > 0
            ? h('div', { className: 'sdw-mono', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11.5px' } },
              `${t('uploadsBytes')} ≤ ${formatFileSize(limit)}`)
            : null),
        h('div', { className: 'sdw-card-desc' }, t('uploadsDesc')),
        h('div', { className: 'sdw-upload-row' },
          h('div', { className: 'sdw-upload-main' },
            h('input', {
              className: 'sdw-file',
              type: 'file',
              disabled: Boolean(busy) || sending,
              onChange: (event) => {
                const picked = event?.target?.files?.[0] || null
                setFile(picked)
              },
            }),
            file
              ? h('div', { className: 'sdw-upload-meta' }, `${t('uploadsFile')}: ${file.name} · ${formatFileSize(file.size)}`)
              : h('div', { className: 'sdw-upload-meta' }, t('uploadsNoFile'))),
          h('button', {
            className: 'sdw-btn primary',
            disabled: Boolean(busy) || sending || !file,
            onClick: () => { if (file) void onPush(file) },
          }, t('uploadsSend'))),
        sending
          ? h('div', { className: 'sdw-upload-row' },
            h('div', { className: 'sdw-upload-main' },
              h('div', { className: 'sdw-upload-meta' }, `${t('uploadsProgress')} ${push.sent}/${push.total} (${progress}%)`),
              h('div', { className: 'sdw-upload-progress' }, h('span', { style: { width: `${progress}%` } }))))
          : null,
        push?.status === 'done'
          ? h('div', { className: 'sdw-card-desc sdw-upload-ok' }, `${t('uploadsDone')}: ${push.name} · ${formatFileSize(push.size)} · ${t('uploadsHash')} ${String(push.sha256 || '').slice(0, 16)}…`)
          : null,
        push?.status === 'error'
          ? h('div', { className: 'sdw-card-desc sdw-upload-fail' }, `${t('uploadsFailed')}: ${push.error || t('unknownError')}`)
          : null)
    }

    // -----------------------------------------------------------------------
    // Settings page
    // -----------------------------------------------------------------------

    function ShareRows({ panel, t, busy, onToggleWorkspace, onToggleSharing, onKill, onToggleUploads }) {
      const sharing = panel?.sharing || {}
      const workspaces = sharing.workspaces || []
      const uploads = panel?.uploads || {}
      const enabled = sharing.enabled === true
      return h('section', { className: 'sdw-card' },
        h('div', { className: 'sdw-card-head' },
          h('span', { className: `sdw-dot ${enabled && sharing.managedSessions >= 0 ? (sharing.active ? 'on' : 'warn') : ''}` }),
          h('div', { className: 'sdw-card-title' }, t('shareMaster')),
          h(Switch, { on: enabled, disabled: Boolean(busy), label: t('shareMaster'), onChange: onToggleSharing })),
        h('div', { className: 'sdw-card-desc' }, enabled ? t('shareMasterDesc') : `${t('shareOff')} · ${t('shareOffDesc')}`),
        h('div', { className: 'sdw-row' }, h('div', { className: 'sdw-row-main' }, h('div', { className: 'sdw-row-title' }, t('workspaces'))),
          h('div', { className: 'sdw-row-end' },
            h('button', { className: 'sdw-btn danger', disabled: Boolean(busy), onClick: onKill }, t('kill')))),
        workspaces.length === 0
          ? h('div', { className: 'sdw-empty' }, t('workspacesEmpty'))
          : workspaces.map((workspace) => h('div', { className: 'sdw-row', key: workspace.workspaceId },
            h('input', {
              className: 'sdw-check',
              type: 'checkbox',
              checked: workspace.shared === true,
              disabled: Boolean(busy) || !enabled,
              onChange: () => onToggleWorkspace(workspace),
            }),
            h('div', { className: 'sdw-row-main' },
              h('div', { className: 'sdw-row-title' }, workspace.title),
              h('div', { className: 'sdw-row-sub sdw-mono' }, `${workspace.workspaceId} · ${workspace.sessionCount} ${t('workspaceCount')}`)))),
        h('div', { className: 'sdw-upload-row' },
          h('div', { className: 'sdw-upload-main' },
            h('div', { className: 'sdw-row-title' }, t('uploadsReceive')),
            h('div', { className: 'sdw-upload-meta' },
              `${uploads.enabled ? t('uploadsReceiveOn') : t('uploadsReceiveOff')}${uploads.dir ? ` · ${t('uploadsDirHint')}: ${uploads.dir}` : ''}`)),
          h(Switch, {
            on: uploads.enabled === true,
            disabled: Boolean(busy),
            label: t('uploadsReceive'),
            onChange: onToggleUploads,
          })),
        h('div', { className: 'sdw-card-desc', style: { paddingTop: '8px' } }, t('killHint')))
    }

    function DeviceRows({ panel, t }) {
      const peers = panel?.peers || []
      return h('section', { className: 'sdw-card' },
        h('div', { className: 'sdw-card-head' }, h('div', { className: 'sdw-card-title' }, t('devices'))),
        peers.length === 0
          ? h('div', { className: 'sdw-empty' }, t('devicesEmpty'))
          : peers.map((peer) => {
            const reachable = peer.online === true || peer.attached === true
            const status = peer.trusted
              ? (reachable ? t('online') : t('offline'))
              : (peer.attached ? t('attached') : t('untrusted'))
            const presence = peer.attached ? ` · ${t('attached')}` : (peer.lastSeenAt ? ` · ${t('presenceStale')}` : '')
            return h('div', { className: 'sdw-row', key: peer.deviceId },
              h(Dot, { dot: peer.trusted ? (reachable ? 'on' : '') : (peer.attached ? 'on' : 'err') }),
              h('div', { className: 'sdw-row-main' },
                h('div', { className: 'sdw-row-title' }, peer.name || peer.deviceId.slice(0, 12)),
                h('div', { className: 'sdw-row-sub sdw-mono' }, `${peer.deviceId.slice(0, 16)}… · ${status}${presence}`)))
          }))
    }

    function AuditRows({ panel, t, busy, onClear }) {
      const rows = panel?.audit || []
      return h('section', { className: 'sdw-card' },
        h('div', { className: 'sdw-card-head' },
          h('div', { className: 'sdw-card-title' }, t('audit')),
          h('button', { className: 'sdw-btn', disabled: Boolean(busy) || rows.length === 0, onClick: onClear }, t('auditClear'))),
        rows.length === 0
          ? h('div', { className: 'sdw-empty' }, t('auditEmpty'))
          : [...rows].reverse().map((row, index) => h('div', { className: 'sdw-audit-row', key: index },
            h('span', { className: 'sdw-audit-time' }, relTime(row.at)),
            h('span', { className: 'sdw-mono' }, String(row.op || row.action || '')),
            h('span', { className: row.ok === false ? 'sdw-error' : '' },
              row.ok === false ? `${row.code || 'error'}${row.message ? ` · ${row.message}` : ''}` : (row.sessionId ? String(row.sessionId).slice(0, 18) : 'ok')))))
    }

    function WorkspaceAliasRow({ group, t, online }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const alias = workspaceAlias(group)
      const begin = () => { setDraft(alias); setEditing(true) }
      const commit = () => { setWorkspaceAlias(group, draft); setEditing(false) }
      return h('div', { className: 'sdw-row' },
        h(Dot, { dot: online ? 'on' : 'err' }),
        h('div', { className: 'sdw-row-main' },
          editing
            ? h('input', {
              className: 'sdw-alias-input',
              value: draft,
              autoFocus: true,
              placeholder: group.workspaceTitle || '',
              'aria-label': t('rename'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit() }
                else if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
              },
              onBlur: commit,
            })
            : h('div', { className: 'sdw-row-title' }, alias || group.workspaceTitle),
          h('div', { className: 'sdw-row-sub' },
            `${group.sessions.length} ${t('workspaceCount')} · ${group.deviceName || t('displayPeer')}`,
            alias ? ` · ${group.workspaceTitle}` : '')),
        h('div', { className: 'sdw-row-end' },
          editing
            ? [h('button', { key: 'save', type: 'button', className: 'sdw-btn sdw-btn-sm', onClick: commit }, t('renameSave')),
              h('button', { key: 'cancel', type: 'button', className: 'sdw-btn sdw-btn-sm sdw-btn-muted', onClick: () => setEditing(false) }, t('renameCancel'))]
            : h('button', { key: 'rename', type: 'button', className: 'sdw-btn sdw-btn-sm', onClick: begin }, t('rename'))))
    }

    function DisplayRows({ panel, t, busy, onToggleDisplay, onPickPeer }) {
      const display = panel?.display || {}
      const peers = (panel?.peers || []).filter((peer) => peer.trusted)
      const groups = display.groups || []
      const enabled = display.enabled !== false
      const peerSelect = peers.length === 0
        ? h('span', { className: 'sdw-notice' }, t('displayPeerEmpty'))
        : h('select', {
          value: display.peerDeviceId || '',
          disabled: Boolean(busy),
          onChange: (event) => onPickPeer(event.target.value),
          style: {
            height: '30px', borderRadius: '8px', border: '.5px solid var(--dsw-alias-border-l3)',
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12.5px',
          },
        },
        h('option', { value: '' }, t('displayPeerEmpty')),
        peers.map((peer) => h('option', { key: peer.deviceId, value: peer.deviceId },
          `${peer.name || peer.deviceId.slice(0, 10)}${peer.online ? '' : ` (${t('offline')})`}`)))
      const groupRows = groups.length === 0
        ? h('div', { className: 'sdw-empty' }, enabled ? t('noGroups') : t('displayNoPeer'))
        : groups.map((group) => h(WorkspaceAliasRow, {
          key: `${group.deviceId}:${group.workspaceId}`,
          group,
          t,
          online: Boolean(display.state?.online),
        }))
      return h('section', { className: 'sdw-card' },
        h('div', { className: 'sdw-card-head' },
          h('span', { className: `sdw-dot ${display.state?.online ? 'on' : ''}` }),
          h('div', { className: 'sdw-card-title' }, t('displayMaster')),
          h(Switch, { on: enabled, disabled: Boolean(busy), label: t('displayMaster'), onChange: onToggleDisplay })),
        h('div', { className: 'sdw-card-desc' }, enabled ? t('displayMasterDesc') : t('displayOff')),
        h('div', { className: 'sdw-row' },
          h('div', { className: 'sdw-row-main' }, h('div', { className: 'sdw-row-title' }, t('displayPeer'))),
          h('div', { className: 'sdw-row-end' }, peerSelect)),
        groupRows)
    }

    /** One shadow panel: hub (settings + peer workspaces) -> group -> chat. */
    function ShadowApp({ ctx, t }) {
      const [route, setRoute] = useState(() => (typeof window !== 'undefined' ? window.__shadowRoute : null))
      useEffect(() => {
        const onRoute = (event) => {
          setRoute(event?.detail || null)
          if (typeof window !== 'undefined') window.__shadowRoute = null
        }
        const onClose = () => setRoute(null)
        window.addEventListener('shadow:route', onRoute)
        window.addEventListener('shadow:close', onClose)
        return () => {
          window.removeEventListener('shadow:route', onRoute)
          window.removeEventListener('shadow:close', onClose)
        }
      }, [])
      const close = () => ctx?.layout?.selectPanel?.(null)
      if (route?.group) {
        return h(GroupPage, {
          ctx,
          t,
          group: route.group,
          initialSession: route.sessionId ? { sessionId: route.sessionId } : null,
          autoCreate: Boolean(route.create),
          onBack: close,
        })
      }
      return h(SettingsPage, { ctx, t, onOpenGroup: (group) => setRoute({ group }) })
    }

    function SettingsPage({ ctx, t, onOpenGroup }) {
      const [panel, setPanel] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [tab, setTab] = useState('share')
      const [push, setPush] = useState(null)
      const alive = useRef(true)

      const load = useCallback(async (silent) => {
        try {
          const value = await panelApi('')
          if (!alive.current) return
          setPanel(value.state)
          if (!silent) setError('')
        } catch (err) {
          clientDebug('page', `request failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setError(String(err.message || err))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(true)
        }, PANEL_POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const run = useCallback(async (key, action, payload) => {
        setBusy(key)
        setNotice('')
        setError('')
        try {
          const value = await panelApi(action, payload)
          if (alive.current) setPanel(value.state)
          if (action === 'kill') setNotice(t('killed'))
        } catch (err) {
          clientDebug('page', `request failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setError(String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [t])

      const toggleSharing = useCallback((enabled) => {
        void run('sharing', 'set-sharing', { enabled })
      }, [run])

      const toggleWorkspace = useCallback((workspace) => {
        const current = panel?.sharing?.workspaceIds || []
        const next = workspace.shared ? current.filter((id) => id !== workspace.workspaceId) : [...current, workspace.workspaceId]
        void run('workspace', 'set-workspaces', { workspaceIds: next })
      }, [panel, run])

      const toggleDisplay = useCallback((enabled) => {
        void run('display', 'set-display', { enabled })
      }, [run])

      const pickPeer = useCallback((deviceId) => {
        const peer = (panel?.peers || []).find((candidate) => candidate.deviceId === deviceId)
        void run('peer', 'set-peer', { deviceId, name: peer?.name || '' })
      }, [panel, run])

      const clearAudit = useCallback(() => {
        void run('audit', 'clear-audit', {})
      }, [run])

      /**
       * Toggle this device's receive-side file uploads (A half). Uses the data
       * route (`uploads-enable`), which persists the switch in state.json.
       */
      const toggleUploads = useCallback(async (enabled) => {
        setBusy('uploads')
        setError('')
        setNotice('')
        try {
          const value = await dataApi('uploads-enable', { enabled })
          if (alive.current && value?.uploads && panel) {
            setPanel({ ...panel, uploads: { ...(panel.uploads || {}), ...value.uploads } })
          }
          void load(true)
        } catch (err) {
          clientDebug('page', `uploads-enable failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setError(String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [panel, load])

      /**
       * Push one local file to the selected peer: begin -> chunks -> commit
       * through the local data route, which forwards `ext.shadow.push-file`.
       */
      const pushToPeer = useCallback(async (file) => {
        if (!file) {
          setError(t('uploadsNoFile'))
          return
        }
        const peerMax = Number(panel?.uploads?.peer?.maxBytes) || 0
        if (peerMax > 0 && Number(file.size) > peerMax) {
          setPush({ status: 'error', name: String(file.name || ''), error: `> ${formatFileSize(peerMax)}` })
          return
        }
        setError('')
        setNotice('')
        setPush({ status: 'sending', name: String(file.name || ''), sent: 0, total: 0, size: Number(file.size) || 0 })
        try {
          const result = await pushLocalFile({
            push: (payload) => dataApi('push-file', payload),
            file,
            chunkBytes: panel?.uploads?.peer?.chunkBytes,
            onProgress: (progress) => {
              if (!alive.current) return
              setPush({ status: 'sending', name: String(file.name || ''), sent: progress.sent, total: progress.total, size: progress.size })
            },
          })
          if (alive.current) setPush({ status: 'done', ...result })
          clientDebug('upload', `file push committed name=${result.name} size=${result.size} chunks=${result.chunks}`)
          void load(true)
        } catch (err) {
          clientDebug('upload', `file push failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setPush({ status: 'error', name: String(file.name || ''), error: errorLine(err) || String(err.message || err) })
        }
      }, [panel, load, t])

      const peerGroups = Array.isArray(panel?.display?.groups) ? panel.display.groups : []
      const share = h('div', { className: 'sdw-settings' },
        !panel?.sync?.available
          ? h('div', { className: 'sdw-banner sdw-error' }, t('syncMissing'))
          : null,
        h(ShareRows, { panel, t, busy, onToggleSharing: toggleSharing, onToggleWorkspace: toggleWorkspace, onKill: () => void run('kill', 'kill', {}), onToggleUploads: toggleUploads }),
        h(DeviceRows, { panel, t }),
        h(AuditRows, { panel, t, busy, onClear: clearAudit }),
        error ? h('div', { className: 'sdw-status sdw-error' }, error) : null,
        notice ? h('div', { className: 'sdw-status sdw-notice' }, notice) : null)

      const display = h('div', { className: 'sdw-settings' },
        !panel?.sync?.available
          ? h('div', { className: 'sdw-banner sdw-error' }, t('syncMissing'))
          : null,
        h(DisplayRows, { panel, t, busy, onToggleDisplay: toggleDisplay, onPickPeer: pickPeer }),
        h(PushFileCard, { panel, t, busy: Boolean(busy), push, onPush: pushToPeer }),
        h('div', { className: 'sdw-card-desc' }, t('connectHint')),
        error ? h('div', { className: 'sdw-status sdw-error' }, error) : null)

      const shadowBackTarget = shadowReturnPanel.id
      const shadowBack = () => {
        const target = shadowReturnPanel.id
        shadowReturnPanel.id = null
        try { ctx?.layout?.selectPanel?.(target || null) } catch {}
      }

      return h('div', { className: 'sdw-page' },
        h('div', { className: 'sdw-head' },
          h('button', { className: 'sdw-back', onClick: shadowBack }, `← ${shadowBackTarget ? t('backPanel') : t('back')}`),
          h('span', { className: 'sdw-dot on' }),
          h('div', { className: 'sdw-head-main' },
            h('h2', { className: 'sdw-title' }, t('title')),
            h('div', { className: 'sdw-sub' }, panel?.device?.name ? `${panel.device.name} · ${t('subtitle')}` : t('subtitle')))),
        h('div', { className: 'sdw-body' },
          h('div', { className: 'sdw-scroll' },
            peerGroups.length > 0 || panel?.display?.enabled
              ? h('section', { className: 'sdw-sessions', style: { marginBottom: '12px' } },
                h('div', { className: 'sdw-sessions-head' },
                  h('div', { className: 'sdw-sessions-title' }, t('peerGroups')),
                  h('span', { className: 'sdw-sessions-count' }, `${peerGroups.length}`)),
                peerGroups.length === 0
                  ? h('div', { className: 'sdw-empty' }, t('noGroups'))
                  : peerGroups.map((group) => h('button', {
                    key: makeGroupId(group),
                    className: 'sdw-session-row',
                    type: 'button',
                    onClick: () => onOpenGroup?.(group),
                  },
                    h(Dot, { dot: panel?.display?.online === false ? 'err' : 'on' }),
                    h('span', { className: 'sdw-session-row-main' },
                      h('span', { className: 'sdw-session-row-title' }, `${group.deviceName}${t('groupSuffix')} · ${group.workspaceTitle}`),
                      h('span', { className: 'sdw-session-row-preview' }, `${(group.sessions || []).length} ${t('sessionCountUnit')}`)),
                    h('span', { className: 'sdw-session-row-side' }, h(IconChevron, null)))))
              : null,
            h('div', { className: 'sdw-tabs' },
              h('button', { className: `sdw-tab${tab === 'share' ? ' active' : ''}`, onClick: () => setTab('share') }, t('tabShare')),
              h('button', { className: `sdw-tab${tab === 'display' ? ' active' : ''}`, onClick: () => setTab('display') }, t('tabDisplay'))),
            tab === 'share' ? share : display,
            h('div', { className: 'sdw-hint', style: { paddingTop: '12px' } },
              `${t('pluginVersion')} v${panel?.version || '—'} · ${t('peerVersion')} v${panel?.display?.peerVersion || '—'}`),
            panel?.paths?.debug
              ? h('div', { className: 'sdw-hint', style: { paddingTop: '12px' } }, `${t('debugLog')}: ${panel.paths.debug}`)
              : null,
            panel === null && !error ? h('div', { className: 'sdw-status' }, t('loading')) : null)))
    }

    // -----------------------------------------------------------------------
    // Model pickers (chat header + new-session preselect)
    // -----------------------------------------------------------------------

    /** `${provider}::${model}` key for the model `<select>`. */
    function modelKey(selection) {
      if (!selection || typeof selection !== 'object') return ''
      const provider = String(selection.provider ?? '')
      const model = String(selection.model ?? '')
      return provider && model ? `${provider}::${model}` : ''
    }

    /** Find `{group, model}` for a selection in the catalogue. */
    function findCatalogModel(catalog, selection) {
      if (!catalog || !selection || typeof selection !== 'object') return null
      const provider = String(selection.provider ?? '')
      const modelId = String(selection.model ?? '')
      for (const group of catalog.groups || []) {
        if (provider && group.id !== provider) continue
        for (const model of group.models || []) {
          if (model.id === modelId) return { group, model }
        }
      }
      return null
    }

    /** Human label for one model selection (`Provider · Model`). */
    function modelLabel(catalog, selection) {
      const found = findCatalogModel(catalog, selection)
      if (found) return `${found.group.label || found.group.id} · ${found.model.name || found.model.id}`
      if (selection && selection.model) return String(selection.model)
      return ''
    }

    /**
     * Native <select> popups are drawn by the OS and only follow the computed
     * `color-scheme`. Mirror the current DSH surface (light/dark token theme)
     * so the model/effort drawers are not stuck on a white panel in dark mode.
     */
    function useNativeColorScheme() {
      const detect = () => {
        try {
          const probe = document.body || document.documentElement
          const color = getComputedStyle(probe).backgroundColor || ''
          const match = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
          if (match) {
            const luma = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
            return luma < 0.5 ? 'dark' : 'light'
          }
        } catch {}
        return 'light'
      }
      const [scheme, setScheme] = useState(detect)
      useEffect(() => {
        const update = () => setScheme(detect())
        const observer = typeof MutationObserver !== 'undefined'
          ? new MutationObserver(update)
          : null
        if (observer) {
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme', 'data-dsw-theme'],
          })
        }
        const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
        const onChange = () => update()
        if (media && typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
        update()
        return () => {
          if (observer) observer.disconnect()
          if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange)
        }
      }, [])
      return scheme
    }

    function ModelSelect({ catalog, value, onChange, disabled, t, allowDefault, className }) {
      const colorScheme = useNativeColorScheme()
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const current = modelKey(value)
      const options = []
      if (allowDefault) options.push(h('option', { key: '__default__', value: '' }, t('modelDefault')))
      for (const group of groups) {
        options.push(h('optgroup', { key: group.id, label: group.label || group.id },
          (group.models || []).map((model) => h('option', {
            key: `${group.id}::${model.id}`,
            value: `${group.id}::${model.id}`,
          }, `${model.name || model.id}`))))
      }
      const known = groups.some((group) => (group.models || []).some((model) => `${group.id}::${model.id}` === current))
      const hasOptions = groups.length > 0
      return h('select', {
        className: className || 'sdw-select',
        value: known ? current : '',
        disabled: Boolean(disabled) || !hasOptions,
        style: { colorScheme },
        title: t('modelSelect'),
        'aria-label': t('modelSelect'),
        onChange: (event) => {
          const raw = String(event.target.value || '')
          if (!raw) { onChange(null); return }
          const split = raw.indexOf('::')
          const provider = raw.slice(0, split)
          const model = raw.slice(split + 2)
          const found = groups
            .find((group) => group.id === provider)
            ?.models?.find((entry) => entry.id === model) || null
          const effort = found?.reasoning?.defaultEffort || ''
          onChange({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) })
        },
      },
        !allowDefault && !known
          ? h('option', { key: '__current__', value: '' }, current ? t('modelSelect') : t('modelSelect'))
          : null,
        options)
    }

    /** Reasoning-effort selector for models that expose efforts. */
    function EffortSelect({ catalog, value, onChange, disabled, t, className }) {
      const colorScheme = useNativeColorScheme()
      const found = findCatalogModel(catalog, value)
      const efforts = found?.model?.reasoning?.efforts || []
      if (efforts.length === 0) return null
      const current = value?.reasoningEffort || found.model.reasoning.defaultEffort || efforts[0]?.id || ''
      return h('select', {
        className: className || 'sdw-select',
        value: current,
        disabled: Boolean(disabled),
        style: { colorScheme },
        title: t('effortLabel'),
        'aria-label': t('effortLabel'),
        onChange: (event) => onChange({ ...(value || {}), reasoningEffort: String(event.target.value || '') }),
      }, efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)))
    }

    // -----------------------------------------------------------------------
    // Group page (session list) + chat page
    // -----------------------------------------------------------------------

    function SessionRow({ session, approvals, active, onOpen, t }) {
      const status = statusOf(session, approvals)
      const showDot = ['running', 'waiting', 'lost', 'failed', 'blocked'].includes(status.kind)
      const subtitle = session.lastText
        ? firstLine(session.lastText, 140)
        : [t(status.key), session.model?.model ? String(session.model.model) : ''].filter(Boolean).join(' · ')
      return h('button', {
        className: `sdw-session-row${active ? ' active' : ''}`,
        type: 'button',
        onClick: () => onOpen(session.sessionId),
      },
        showDot ? h(Dot, { dot: status.dot }) : h('span', { className: 'sdw-session-row-spacer' }),
        h('span', { className: 'sdw-session-row-main' },
          h('span', { className: 'sdw-session-row-title' }, session.title || session.sessionId.slice(0, 18)),
          subtitle ? h('span', { className: 'sdw-session-row-preview' }, subtitle) : null),
        h('span', { className: 'sdw-session-row-side' },
          session.pendingApprovals > 0
            ? h('span', { className: 'sdw-session-badge' }, String(session.pendingApprovals))
            : null,
          h('span', { className: 'sdw-session-row-time' }, relTime(session.updatedAt))))
    }

    function GroupPage({ ctx, t, group, onBack, initialSession, autoCreate }) {
      const [state, setState] = useState(null)
      const [activeSession, setActiveSession] = useState(initialSession || null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [catalog, setCatalog] = useState(null)
      const [modelsError, setModelsError] = useState('')
      const [newModel, setNewModel] = useState(null)
      const alive = useRef(true)

      const load = useCallback(async (silent) => {
        try {
          const value = await dataApi('state')
          if (!alive.current) return
          setState(value.state)
          if (!silent) setError('')
        } catch (err) {
          clientDebug('page', `request failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setError(String(err.message || err))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(true)
        }, PANEL_POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      // Model catalogue for the new-session preselect; failure is shown, never
      // silent (sessions can still be created with the deployment default).
      useEffect(() => {
        let mounted = true
        dataApi('models').then((value) => {
          if (!mounted) return
          setCatalog(value.models || null)
          setModelsError('')
        }).catch((err) => {
          clientDebug('group', `model catalogue failed: ${errorLine(err)}`, 'warn')
          if (mounted) setModelsError(`${t('modelListFailed')}: ${errorLine(err)}`)
        })
        return () => { mounted = false }
      }, [t])

      const workspace = useMemo(() => {
        const workspaces = state?.workspaces || []
        return workspaces.find((candidate) => candidate.workspaceId === group.workspaceId) || null
      }, [group.workspaceId, state])

      // Union of the aggregated workspace rows and the flat session list: a Host
      // grouping/coverage regression must never hide a session (B-side report:
      // "the old session disappeared after the update").
      const sessions = useMemo(() => {
        const grouped = Array.isArray(workspace?.sessions) ? workspace.sessions : []
        const flat = (Array.isArray(state?.sessions) ? state.sessions : [])
          .filter((row) => String(row?.workspaceId ?? '') === String(group.workspaceId))
        if (flat.length === 0) return grouped
        const byId = new Map()
        for (const row of [...grouped, ...flat]) {
          if (!row?.sessionId) continue
          byId.set(row.sessionId, { ...(byId.get(row.sessionId) || {}), ...row })
        }
        return [...byId.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      }, [group.workspaceId, state, workspace])

      // Native workspace list groups sessions by day (今天 / 昨天 / 更早).
      const sessionGroups = useMemo(() => {
        const now = new Date()
        const dayStart = (value) => {
          const date = new Date(value)
          return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        }
        const today = dayStart(now)
        const yesterday = today - 24 * 60 * 60 * 1000
        const buckets = new Map([['today', []], ['yesterday', []], ['earlier', []]])
        for (const session of sessions) {
          const at = Date.parse(session.updatedAt || '') || 0
          const key = at >= today ? 'today' : at >= yesterday ? 'yesterday' : 'earlier'
          buckets.get(key).push(session)
        }
        return ['today', 'yesterday', 'earlier']
          .filter((key) => buckets.get(key).length > 0)
          .map((key) => ({
            key,
            label: t(key === 'today' ? 'groupToday' : key === 'yesterday' ? 'groupYesterday' : 'groupEarlier'),
            items: buckets.get(key),
          }))
      }, [sessions, t])

      const createSession = useCallback(async () => {
        setBusy('create')
        setError('')
        clientDebug('group', `create session requested workspace=${group.workspaceId} model=${newModel ? `${newModel.provider}/${newModel.model}` : '(default)'}`)
        try {
          const value = await dataApi('create', {
            workspaceId: group.workspaceId,
            ...(newModel ? { model: newModel } : {}),
          })
          const created = value.created || {}
          if (created.modelError && alive.current) setError(`${t('modelSwitchFailed')}: ${created.modelError}`)
          if (created.sessionId && alive.current) {
            setActiveSession({
              sessionId: created.sessionId,
              title: created.title,
              status: 'idle',
              updatedAt: new Date().toISOString(),
              model: created.model || newModel || null,
            })
          }
          void load(true)
        } catch (err) {
          clientDebug('page', `request failed: ${errorLine(err)}`, 'warn')
          if (alive.current) setError(String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }, [group.workspaceId, load, newModel, t])

      // Launcher routes can target a concrete session or ask for a fresh one.
      useEffect(() => {
        if (initialSession?.sessionId) setActiveSession(initialSession)
      }, [initialSession])

      const autoCreated = useRef(false)
      useEffect(() => {
        if (!autoCreate || autoCreated.current) return
        autoCreated.current = true
        void createSession()
      }, [autoCreate, createSession])

      if (activeSession) {
        return h(ChatPage, { ctx, t, group, sessionMeta: activeSession, onBack: () => setActiveSession(null) })
      }

      const online = state?.online && state?.sharing?.enabled !== false
      return h('div', { className: 'sdw-page' },
        h('div', { className: 'sdw-head' },
          h('button', { className: 'sdw-back', onClick: () => (onBack ? onBack() : ctx?.layout?.selectPanel?.(SETTINGS_KEY)) }, `← ${t('backPanel')}`),
          h(Dot, { dot: online ? 'on' : 'err' }),
          h('div', { className: 'sdw-head-main' },
            h('h2', { className: 'sdw-title' }, `${group.deviceName}${t('groupSuffix')}`),
            h('div', { className: 'sdw-sub' }, `${group.workspaceTitle}${online ? '' : ` · ${t('statusDisconnected')}`}`)),
          h('div', { className: 'sdw-head-actions' },
            h(ModelSelect, {
              catalog,
              value: newModel,
              onChange: setNewModel,
              disabled: Boolean(busy),
              t,
              allowDefault: true,
            }),
            h('button', { className: 'sdw-btn primary', disabled: busy || !online, onClick: () => void createSession() }, `+ ${t('newSession')}`))),
        modelsError ? h('div', { className: 'sdw-model-error', style: { padding: '8px 20px 0' } }, modelsError) : null,
        h('div', { className: 'sdw-body' },
          h('div', { className: 'sdw-scroll' },
            h('section', { className: 'sdw-sessions' },
              h('div', { className: 'sdw-sessions-head' },
                h('div', { className: 'sdw-sessions-title' }, t('sessions')),
                h('span', { className: 'sdw-sessions-count' }, `${sessions.length} ${t('sessionCountUnit')}`),
                h('button', {
                  className: 'sdw-icon-btn',
                  type: 'button',
                  title: t('refresh'),
                  'aria-label': t('refresh'),
                  onClick: () => void load(false),
                }, h(IconRefresh, null))),
              sessions.length === 0
                ? h('div', { className: 'sdw-empty' }, t('sessionsEmpty'))
                : sessionGroups.map((bucket) => h('div', { className: 'sdw-session-group', key: bucket.key },
                  h('div', { className: 'sdw-session-group-label' }, bucket.label),
                  bucket.items.map((session) => h(SessionRow, {
                    key: session.sessionId,
                    session,
                    approvals: [],
                    active: false,
                    // Pass the full row: ChatPage reads sessionId/title/model.
                    onOpen: (sessionId) => setActiveSession(sessions.find((row) => row.sessionId === sessionId) || { sessionId }),
                    t,
                  }))))),
            error ? h('div', { className: 'sdw-status sdw-error' }, error) : null)))
    }

    // =======================================================================
    // Native chat surface (0.10.19)
    // -----------------------------------------------------------------------
    // 1:1 replica of the DSH conversation window. Hashed class names are
    // discovered from the live stylesheets (same contract as the sidebar
    // replica): plugin modules are `<prefix>_<key>`, shell/primitives modules
    // are `_<key>_<hash>_<line>`. Rows mirror the native DOM tree and data-*
    // attributes so the shipped CSS drives typography, spacing and states.
    // =======================================================================
    const nativeChatUi = (() => {
      let cached
      let attempted = false
      const scan = () => {
        let text = ''
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.selectorText) text += rule.selectorText + '{}'
            else if (rule.cssRules) walk(rule.cssRules)
          }
        }
        try {
          for (const sheet of Array.from(document.styleSheets || [])) {
            let rules = null
            try { rules = sheet.cssRules } catch {}
            if (rules) walk(rules)
          }
        } catch {}
        return text
      }
      const plugin = (text, marker, keys) => {
        const found = new RegExp('\\.([A-Za-z0-9_-]{5,12})_' + marker + '(?![A-Za-z0-9_-])').exec(text)
        if (!found) return null
        const prefix = found[1]
        const entry = {}
        for (const key of keys) {
          if (text.indexOf('.' + prefix + '_' + key) < 0) return null
          entry[key] = prefix + '_' + key
        }
        return entry
      }
      const hashed = (text, marker, keys) => {
        const found = new RegExp('\\._' + marker + '_([a-z0-9]{5})_\\d+').exec(text)
        if (!found) return null
        const id = found[1]
        const entry = {}
        for (const key of keys) {
          const hit = new RegExp('\\._(' + key + '_' + id + '_\\d+)').exec(text)
          if (!hit) return null
          entry[key] = '_' + hit[1]
        }
        return entry
      }
      const build = () => {
        const text = scan()
        if (!text) return null
        const view = plugin(text, 'flowItem', ['root', 'scroll', 'column', 'running', 'runningDivider', 'runningContent', 'runningIcon', 'runningText', 'toBottomSlot', 'toBottom', 'hint'])
        const message = plugin(text, 'userStack', ['userRow', 'userStack', 'bubble'])
        const conversation = plugin(text, 'composerSeat', ['root', 'header', 'headerLeading', 'titleRow', 'titleCluster', 'crumbs', 'crumbSeg', 'crumb', 'crumbCurrent', 'headerActions', 'body', 'scrollBody', 'viewArea', 'composerSeat', 'composerStack'])
        const input = plugin(text, 'cardWorkspaceTrigger', ['root', 'notice', 'card', 'scroll', 'grow', 'input', 'placeholder', 'row', 'tools', 'trailing', 'standardControls', 'add', 'select', 'primary'])
        const tool = plugin(text, 'inspectButton', ['root', 'leading', 'title', 'sep', 'summary', 'summarySuffix', 'diffStat', 'diffAdded', 'diffRemoved', 'errorSummary', 'bodyWrap', 'detailsBodyWrap', 'ioCard', 'ioSection', 'ioLabel', 'ioText'])
        const disclosure = hashed(text, 'leading', ['header', 'row', 'leading', 'iconIdle', 'chevronHover', 'title', 'root'])
        if (!view || !message || !conversation || !input || !tool || !disclosure) return null
        // Markdown scope: several modules expose a `markdown` key (file-type
        // icons etc.); the real text module also owns `compact` / `tableScroll`.
        const markdownHashes = []
        {
          const re = /\._markdown_([a-z0-9]{5})_\d+/g
          let hit
          while ((hit = re.exec(text))) if (markdownHashes.indexOf(hit[1]) < 0) markdownHashes.push(hit[1])
        }
        const markdownHash = markdownHashes.find((hash) => text.indexOf('._compact_' + hash + '_') >= 0) || markdownHashes[0] || ''
        let markdownScope = ''
        let tableScroll = ''
        if (markdownHash) {
          const scopeHit = new RegExp('\\.(_markdown_' + markdownHash + '_\\d+)').exec(text)
          markdownScope = scopeHit ? scopeHit[1] : ''
          const tableHit = new RegExp('\\.(_tableScroll_' + markdownHash + '_\\d+)').exec(text)
          tableScroll = tableHit ? tableHit[1] : ''
        }
        return {
          view,
          message,
          assistant: plugin(text, 'stopped', ['root', 'body']),
          iconActions: plugin(text, 'timeStart', ['actions', 'action', 'timeStart', 'timeEnd']),
          seat: plugin(text, 'activityIcon', ['body', 'content']),
          reasoning: plugin(text, 'thinkBody', ['root', 'row', 'leading', 'separator', 'summary', 'summaryText', 'thinkBody']),
          turnProcess: plugin(text, 'durationNumber', ['root', 'label', 'chevron', 'durationNumber']),
          tool,
          conversation,
          input,
          primitives: {
            disclosure,
            button: hashed(text, 'button', ['button', 'ghost', 'sm']),
            codeBlock: hashed(text, 'bannerWrap', ['block', 'bannerWrap', 'banner', 'infostring', 'action', 'copyButton', 'content']),
            markdown: markdownScope,
            tableScroll,
          },
        }
      }
      return () => {
        if (attempted) return cached
        attempted = true
        try { cached = build() } catch { cached = null }
        return cached
      }
    })()
    const ncUi = () => nativeChatUi()

    /** First N lines of a tool result, with a truncation marker. */
    function firstLines(text, max = 120) {
      const value = String(text ?? '').replace(/\r\n/g, '\n')
      if (!value) return ''
      const lines = value.split('\n')
      if (lines.length <= max) return value
      return `${lines.slice(0, max).join('\n')}\n… (+${lines.length - max})`
    }

    // --- markdown ---------------------------------------------------------
    function NcCodeBlock({ lang, code, t }) {
      const ui = ncUi()
      const cb = (ui && ui.primitives.codeBlock) || null
      const copy = () => { void copyText(code).then(() => {}) }
      return h('div', { className: `md-code-block${cb ? ' ' + cb.block : ''}`, 'data-code-block': '' },
        h('div', { className: cb ? cb.bannerWrap : 'sdc-codebanner', 'data-code-block-banner': '' },
          h('div', { className: cb ? cb.banner : undefined },
            h('span', { className: cb ? cb.infostring : 'sdc-codelang' }, lang || 'text'),
            h('div', { className: cb ? cb.action : undefined },
              h('button', {
                type: 'button',
                className: cb ? cb.copyButton : 'sdc-codecopy',
                'aria-label': t('copyMessage'),
                onClick: copy,
              }, t('copy'))))),
        h('div', { className: cb ? cb.content : undefined },
          h('pre', null, h('code', null, code))))
    }

    function NcMdBlock(block, index, t) {
      switch (block.type) {
        case 'heading':
          return h(`h${Math.min(6, Math.max(1, block.level))}`, { key: `nmd${index}` }, renderInline(block.text, `nmd${index}-`))
        case 'hr':
          return h('hr', { key: `nmd${index}` })
        case 'code':
          return h(NcCodeBlock, { key: `nmd${index}`, lang: block.lang, code: block.code, t })
        case 'table':
          return h('div', { key: `nmd${index}`, className: `${(ncUi().primitives.tableScroll) || 'sdw-nc-table'}${(ncUi().primitives.markdown) ? ' md-table-wide' : ''}`, tabIndex: 0, role: 'region' },
            h('table', null,
              h('thead', null, h('tr', null, block.head.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(cell, `nmd${index}h${cellIndex}-`))))),
              h('tbody', null, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
                block.head.map((_, cellIndex) => h('td', { key: cellIndex }, renderInline(row[cellIndex] ?? '', `nmd${index}r${rowIndex}c${cellIndex}-`))))))))
        case 'quote':
          return h('blockquote', { key: `nmd${index}` }, h('div', null, markdownBlocks(block.text).map((inner, innerIndex) => NcMdBlock(inner, innerIndex, t))))
        case 'list': {
          const root = []
          const stack = [{ depth: -1, children: root }]
          for (const item of block.items) {
            while (stack.length > 1 && item.depth <= stack[stack.length - 1].depth) stack.pop()
            const parent = stack[stack.length - 1]
            const node = { text: item.text, children: [] }
            parent.children.push(node)
            stack.push({ depth: item.depth, children: node.children })
          }
          const renderList = (items, ordered, level) => h(ordered && level === 0 ? 'ol' : 'ul', { key: `nmd${index}l${level}-${items.length}` },
            items.map((item, itemIndex) => h('li', { key: `nmd${index}i${level}-${itemIndex}` },
              renderInline(item.text, `nmd${index}i${level}${itemIndex}-`),
              item.children.length ? renderList(item.children, ordered, level + 1) : null)))
          return renderList(root, block.ordered, 0)
        }
        default:
          return h('p', { key: `nmd${index}` }, renderInline(block.text, `nmd${index}-`))
      }
    }

    function NcMarkdown({ text, streaming, compact, t }) {
      const ui = ncUi()
      const scope = (ui && ui.primitives.markdown) || 'sdc-md'
      const blocks = markdownBlocks(String(text || ''))
      const nodes = blocks.map((block, index) => NcMdBlock(block, index, t))
      if (streaming) nodes.push(h('span', { key: 'nc-caret', className: 'sdw-nc-caret', 'aria-hidden': 'true' }))
      return h('div', { className: `${scope}${compact ? ' sdw-nc-compact' : ''}`, 'data-shadow-md': compact ? 'compact' : 'full' }, nodes)
    }

    // --- message rows -----------------------------------------------------
    function NcUserRow({ user, t }) {
      const ui = ncUi()
      const M = ui.message
      const A = ui.iconActions || null
      return h('div', { className: M.userRow, 'data-chat-flow-kind': 'user', 'data-shadow-row': 'user' },
        h('div', { className: M.userStack },
          h('div', { className: M.bubble }, user.text)),
        A
          ? h('div', { className: A.actions, 'data-clock': 'start', 'data-actions-reveal': 'hover' },
            h('span', { className: A.timeStart }, relativeTime(user.at)),
            h('button', {
              type: 'button',
              className: A.action,
              title: t('copyMessage'),
              'aria-label': t('copyMessage'),
              onClick: () => { void copyText(String(user.text || '')).then(() => {}) },
            }, h(IconCopy, null)))
          : null)
    }

    function NcAssistant({ text, streaming, t }) {
      const ui = ncUi()
      const A = (ui && ui.assistant) || null
      return h('div', {
        className: A ? A.root : 'sdw-nc-assistant',
        'data-chat-group-part': 'response',
        'data-chat-flow-kind': 'assistant-step',
        'data-streaming': streaming ? '' : undefined,
        'data-shadow-row': 'assistant',
      },
        h('div', { className: A ? A.body : undefined }, h(NcMarkdown, { text, streaming, t })))
    }

    // --- reasoning row ----------------------------------------------------
    function NcReasoningRow({ item, t }) {
      const ui = ncUi()
      const R = ui.reasoning || {}
      const D = ui.primitives.disclosure
      const [open, setOpen] = useState(false)
      const text = String(item.text || '')
      const summary = firstLine(text.replace(/\*\*/g, ''), 120)
      const streaming = item.streaming === true
      const preview = !open && summary !== ''
      return h('div', {
        className: R.root || 'sdw-nc-row',
        'data-variant': 'think',
        'data-state': streaming ? 'running' : 'ok',
        'data-expanded': open ? '' : undefined,
        'data-preview': preview ? '' : undefined,
        'data-shadow-row': 'reasoning',
      },
        h('div', { className: D.root, 'data-open': open ? '' : undefined },
          h('div', { className: D.header },
            h('div', {
              className: `${D.row}${R.row ? ' ' + R.row : ''}`,
              'data-disclosure-row': '',
              'data-expandable': '',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open ? 'true' : 'false',
              onClick: () => setOpen((value) => !value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setOpen((value) => !value)
              },
            },
              h('span', { className: `${D.leading}${R.leading ? ' ' + R.leading : ''}` },
                h(IconThink, { className: D.iconIdle }),
                h(IconChevron, { className: D.chevronHover })),
              h('span', { className: D.title }, t('thinkTitle')),
              preview ? h('span', { className: R.separator || 'sdw-nc-sep' }) : null,
              preview
                ? h('span', { className: R.summary || 'sdw-nc-reasoning-summary', 'data-streaming': streaming ? '' : undefined },
                  h('span', { className: R.summaryText || undefined }, summary))
                : null)),
          open
            ? h('div', { className: R.thinkBody || 'sdw-nc-thinking' }, h(NcMarkdown, { text, compact: true, t }))
            : null))
    }

    // --- tool rows --------------------------------------------------------
    function ncVariant(kind) {
      if (kind === 'command') return 'bash'
      if (kind === 'read') return 'read'
      if (kind === 'write') return 'write'
      if (kind === 'edit') return 'edit'
      if (kind === 'grep' || kind === 'glob') return 'search'
      if (kind === 'web') return 'web'
      return 'others'
    }

    function NcToolBody({ item, model, t }) {
      const ui = ncUi()
      const T = ui.tool
      const output = String(model.output || '')
      const sections = []
      const push = (label, text, error) => {
        if (!text) return
        sections.push(h('div', { key: `sec-${sections.length}`, className: T.ioSection, 'data-error': error ? '' : undefined },
          h('span', { className: T.ioLabel }, label),
          h('span', { className: T.ioText }, text)))
      }
      if (model.kind === 'command') {
        push(t('toolCommand'), model.command?.text || '')
        push(t('toolOutput'), firstLines(output, 200), model.exit?.failed === true || item.row?.isError === true)
      } else if (model.kind === 'edit') {
        push(t('toolEdit'), `${model.path || ''}  +${model.diffStat?.added || 0} -${model.diffStat?.removed || 0}`)
        push(t('toolOutput'), firstLines(output, 120))
      } else if (model.kind === 'read') {
        push(t('toolRead'), model.read?.path || model.path || '')
        push(t('toolOutput'), firstLines(output, 160))
      } else if (model.kind === 'grep' || model.kind === 'glob') {
        push(t('toolGrep'), model.search?.pattern || '')
        push(t('toolOutput'), firstLines(output, 160))
      } else {
        push(t('toolArgs'), firstLines(String(item.row?.args || ''), 40))
        push(t('toolOutput'), firstLines(output, 160), item.row?.isError === true)
      }
      return h('div', { className: T.ioCard }, sections.length
        ? sections
        : h('div', { className: T.ioSection }, h('span', { className: T.ioText }, t('toolEmptyOutput'))))
    }

    function NcToolRow({ item, t }) {
      const ui = ncUi()
      const T = ui.tool
      const D = ui.primitives.disclosure
      const [open, setOpen] = useState(false)
      const row = item.row || {}
      const model = toolRowModel(row, t)
      const running = toolRowRunning(row)
      const failed = row.isError === true
      const variant = ncVariant(model.kind)
      const label = toolKindLabel(model.kind, t)
      // Native "提问" row: `{answered}/{total} 已回答` (after the tool result
      // lands) and the Q/A pairs inside the disclosure. This replaces the old
      // pinned "已回答" card above the composer.
      const question = model.kind === 'question' ? questionRowModel(row, t) : null
      let summary = ''
      if (question) summary = question.summary
      else if (model.kind === 'command') summary = model.command?.text || ''
      else if (model.kind === 'edit' || model.kind === 'write' || model.kind === 'read') summary = model.path || ''
      else if (model.kind === 'grep' || model.kind === 'glob') summary = model.search?.pattern || ''
      else if (model.kind === 'web') summary = model.web?.url || ''
      else summary = model.path || firstLine(String(row.args || ''), 90) || row.name || ''
      const duration = row.durationMs ? formatDuration(row.durationMs) : ''
      return h('div', {
        className: T.root,
        'data-variant': variant,
        'data-tool': String(row.name || ''),
        'data-state': running ? 'running' : failed ? 'error' : 'ok',
        'data-shadow-row': 'tool',
      },
        h('div', { className: D.root, 'data-open': open ? '' : undefined },
          h('div', { className: D.header },
            h('div', {
              className: `${D.row}${T.row ? ' ' + T.row : ''}`,
              'data-disclosure-row': '',
              'data-expandable': '',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open ? 'true' : 'false',
              onClick: () => setOpen((value) => !value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setOpen((value) => !value)
              },
            },
              h('span', { className: `${D.leading}${T.leading ? ' ' + T.leading : ''}` },
                h(IconTool, { kind: model.kind }),
                h(IconChevron, { className: D.chevronHover })),
              h('span', { className: `${D.title}${T.title ? ' ' + T.title : ''}` }, label),
              summary ? h('span', { className: T.sep }) : null,
              summary
                ? h('span', { className: failed ? (T.errorSummary || 'sdw-nc-tool-error') : T.summary }, summary)
                : null,
              duration ? h('span', { className: T.summarySuffix }, duration) : null,
              model.diffStat
                ? h('span', { className: `${T.summarySuffix} ${T.diffStat}` },
                  h('span', { className: T.diffAdded }, `+${model.diffStat.added || 0}`),
                  h('span', { className: T.diffRemoved }, `-${model.diffStat.removed || 0}`))
                : null)),
          open
            ? h('div', { className: `${T.bodyWrap} ${T.detailsBodyWrap}` },
              question
                ? h(NcQuestionBody, { model: question, t })
                : h(NcToolBody, { item, model, t }))
            : null))
    }

    // --- one turn ---------------------------------------------------------
    function ncActivityLabel(items, t) {
      let kind = ''
      for (const item of items || []) {
        if (item.kind === 'command') { kind = 'command'; break }
        if (item.kind === 'tool') { kind = item.row?.kind || ''; break }
      }
      if (kind === 'command') return t('activityCommand')
      if (kind === 'read') return t('activityRead')
      if (kind === 'grep' || kind === 'glob' || kind === 'web') return t('activitySearch')
      if (kind === 'edit') return t('activityEdit')
      if (kind === 'write') return t('activityWrite')
      return t('activityOther')
    }

    function NcProcessBlock({ block, t, live }) {
      const ui = ncUi()
      const P = ui.turnProcess || {}
      const S = ui.seat || {}
      const stats = processStats(block)
      // Open while the turn is streaming and collapse once it settles, like the
      // native TurnProcessNodeView. Keyed off the turn-level `live` flag, not
      // per-item running state: between two tool calls `processStats.running`
      // briefly flips false, which used to re-open/close the group on every
      // event (visible flicker until the turn finished).
      const [open, setOpen] = useState(live === true)
      const manual = useRef(false)
      const bodyRef = useRef(null)
      useEffect(() => {
        if (manual.current) return
        setOpen(live === true)
      }, [live])
      const toggle = () => {
        manual.current = true
        setOpen((value) => !value)
      }
      const active = live === true || stats.running === true
      const label = active ? ncActivityLabel(block.items, t) : t('processDone')
      const totalMs = (block.items || []).reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0)
      const duration = active || totalMs <= 0 ? '' : formatDuration(totalMs)
      // The native process body is its own bounded scroller; while the turn is
      // live it keeps the newest reasoning/tool operation in view.
      const items = block.items || []
      const lastItem = items[items.length - 1]
      const contentKey = [
        items.length,
        lastItem?.text?.length || 0,
        lastItem?.row?.result?.length || 0,
        lastItem?.row?.output?.length || 0,
      ].join('|')
      useEffect(() => {
        const node = bodyRef.current
        if (!node || live !== true) return
        node.scrollTop = node.scrollHeight
      }, [contentKey, live, open])
      return h('div', {
        className: 'sdw-nc-process',
        'data-chat-flow-kind': 'turn-process',
        'data-shadow-row': 'process',
        'data-chat-group-key': block.key,
      },
        h('button', {
          type: 'button',
          className: P.root || 'sdw-nc-process-head',
          'data-open': open ? '' : undefined,
          'data-turn-process': '',
          'aria-expanded': open ? 'true' : 'false',
          onClick: toggle,
        },
          h('span', { className: P.label || 'sdw-nc-process-label' },
            label,
            duration
              ? h('span', null, `，${t('usedTime')} `, h('span', { className: P.durationNumber || 'sdw-nc-duration' }, duration))
              : null),
          h(IconChevron, { className: P.chevron || 'sdw-nc-process-chevron' })),
        open
          ? h('div', { className: S.body || 'sdw-nc-process-body', 'data-step-process-body': '', ref: bodyRef },
            h('div', { className: S.content || 'sdw-nc-process-content', 'data-chat-flow': '' },
              block.items.map((item) => {
                switch (item.kind) {
                  case 'reasoning': return h(NcReasoningRow, { key: item.key, item, t })
                  case 'tool': return h(NcToolRow, { key: item.key, item, t })
                  case 'command': return h(NcToolRow, {
                    key: item.key,
                    item: {
                      ...item,
                      row: {
                        kind: 'command',
                        name: 'command',
                        args: JSON.stringify({ command: (item.row || {}).args || (item.row || {}).name || '' }),
                        result: (item.row || {}).done ? String((item.row || {}).output || 'ok') : undefined,
                        isError: (item.row || {}).failed === true,
                      },
                    },
                    t,
                  })
                  case 'job': return h(NcToolRow, {
                    key: item.key,
                    item: {
                      ...item,
                      row: {
                        kind: 'job',
                        name: 'job',
                        args: JSON.stringify({ label: (item.row || {}).name || (item.row || {}).label || '' }),
                        result: (item.row || {}).finishedAt ? 'done' : undefined,
                        isError: false,
                      },
                    },
                    t,
                  })
                  case 'todo': return h(NcToolRow, {
                    key: item.key,
                    item: { ...item, row: { kind: 'todo', name: 'todo_write', args: JSON.stringify(item.todos || []), result: 'ok' } },
                    t,
                  })
                  case 'error': return h('div', { key: item.key, className: 'sdw-nc-error' }, item.text)
                  default: return null
                }
              })))
          : null)
    }

    function NcTurn({ turn, t, latest, live }) {
      const nodes = []
      if (turn.user && turn.user.text) nodes.push(h(NcUserRow, { key: `${turn.key}-user`, user: turn.user, t }))
      for (const block of turn.blocks) {
        if (block.kind === 'process') nodes.push(h(NcProcessBlock, { key: block.key, block, t, live }))
        else nodes.push(h(NcAssistant, { key: block.key || `${turn.key}-resp`, text: block.text, streaming: block.streaming === true, t }))
      }
      const lastResponse = [...turn.blocks].reverse().find((block) => block.kind === 'response')
      if (lastResponse) {
        const ui = ncUi()
        const A = ui.iconActions || {}
        const last = turn.tail?.at || turn.at
        const duration = turn.at && last > turn.at ? formatDuration(last - turn.at) : ''
        nodes.push(h('div', {
          key: `${turn.key}-tail`,
          className: A.actions || 'sdw-nc-tail',
          'data-clock': 'end',
          'data-actions-reveal': latest ? 'always' : 'hover',
          'data-shadow-row': 'tail',
          'data-turn-tail': 'turn',
        },
          h('span', { className: A.timeEnd || 'sdw-nc-tail-time' }, relativeTime(last)),
          duration ? h('span', { className: 'sdw-nc-tail-meta' }, `· ${t('usedTime')} ${duration}`) : null,
          lastResponse?.text
            ? h('button', {
              type: 'button',
              className: A.action || 'sdw-nc-tail-copy',
              title: t('copyMessage'),
              'aria-label': t('copyMessage'),
              onClick: () => { void copyText(String(lastResponse.text || '')).then(() => {}) },
            }, h(IconCopy, null))
            : null))
      }
      return nodes
    }

    function NcRunningTail({ t }) {
      const ui = ncUi()
      const V = ui.view
      return h('div', { className: V.running, 'data-shadow-row': 'running' },
        h('span', { className: V.runningDivider }),
        h('span', { className: V.runningContent },
          h('span', { className: V.runningIcon }, h(IconThink, null)),
          h('span', { className: V.runningText }, t('thinking'))))
    }

    // --- composer ---------------------------------------------------------
    // Native InputBar shows one compact control: model label + effort + chevron
    // (single trigger), then the mic and the round send/stop button. A bare
    // <select> would size itself by the widest option, so render a trigger whose
    // width follows the current label and open a native-looking menu.
    function NcModelControl({ catalog, value, disabled, t, className, onChange }) {
      const [open, setOpen] = useState(false)
      const [view, setView] = useState('root')
      const [query, setQuery] = useState('')
      const [pos, setPos] = useState(null)
      const buttonRef = useRef(null)
      const found = findCatalogModel ? findCatalogModel(catalog, value) : null
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const modelName = found?.model?.name || found?.model?.id || (value && value.model) || t('modelSelect')
      const efforts = found?.model?.reasoning?.efforts || []
      const effortId = (value && value.reasoningEffort) || found?.model?.reasoning?.defaultEffort || ''
      const effortName = efforts.find((effort) => effort.id === effortId)?.name || (effortId ? effortId : '')
      const anchor = () => {
        const button = buttonRef.current
        const rect = button ? button.getBoundingClientRect() : null
        if (!rect) return
        const card = button.closest ? button.closest('[data-composer-card]') : null
        const cardRect = card ? card.getBoundingClientRect() : null
        const screenWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
        const screenHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
        // Native popovers sit just above the composer card, not over its input.
        const top = cardRect ? cardRect.top : rect.top
        setPos({
          left: Math.max(8, Math.min(rect.left, screenWidth - 320)),
          bottom: Math.max(8, screenHeight - top + 6),
        })
      }
      const toggle = () => {
        if (disabled || groups.length === 0) return
        if (open) { setOpen(false); return }
        anchor()
        setView('root')
        setQuery('')
        setOpen(true)
      }
      useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          const target = event.target
          if (buttonRef.current && buttonRef.current.contains(target)) return
          if (target && target.closest && target.closest('.sdw-nc-modelmenu')) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false) } }
        document.addEventListener('mousedown', close, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('mousedown', close, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', close)
        }
      }, [open])
      const lower = query.trim().toLowerCase()
      const visibleGroups = groups
        .map((group) => ({
          ...group,
          models: (group.models || []).filter((model) => !lower || `${model.name || ''} ${model.id || ''}`.toLowerCase().indexOf(lower) >= 0),
        }))
        .filter((group) => group.models.length > 0)
      const chooseModel = (group, model) => {
        onChange({ provider: group.id, model: model.id, ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) })
        setOpen(false)
      }
      const chooseEffort = (effort) => {
        onChange({ ...(value || {}), reasoningEffort: effort })
        setOpen(false)
      }
      let body = null
      if (view === 'root') {
        body = [
          h('button', {
            key: 'model',
            type: 'button',
            className: 'sdw-nc-menu-row',
            onClick: () => { setView('models'); setQuery('') },
          },
            h('span', { className: 'sdw-nc-menu-row-label' }, t('modelMenuModel')),
            h('span', { className: 'sdw-nc-menu-row-value' }, modelName),
            h('svg', {
              className: 'sdw-nc-menu-row-chevron',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            }, h('path', { d: 'M9.5 6 15.5 12 9.5 18' }))),
          h('button', {
            key: 'effort',
            type: 'button',
            className: 'sdw-nc-menu-row',
            disabled: efforts.length === 0,
            onClick: () => setView('effort'),
          },
            h('span', { className: 'sdw-nc-menu-row-label' }, t('effortLabel')),
            h('span', { className: 'sdw-nc-menu-row-value' }, effortName || t('effortDefault')),
            h('svg', {
              className: 'sdw-nc-menu-row-chevron',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            }, h('path', { d: 'M9.5 6 15.5 12 9.5 18' }))),
        ]
      } else if (view === 'models') {
        body = [
          h('input', {
            key: 'search',
            className: 'sdw-nc-menu-search',
            value: query,
            autoFocus: true,
            placeholder: t('modelSearch'),
            'aria-label': t('modelSearch'),
            onChange: (event) => setQuery(event.target.value),
          }),
          ...visibleGroups.map((group) => h('div', { key: group.id, className: 'sdw-nc-menu-group' },
            h('div', { className: 'sdw-nc-menu-label' }, group.label || group.id),
            group.models.map((model) => {
              const selected = Boolean(value && value.model === model.id && value.provider === group.id)
              return h('button', {
                key: model.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected ? 'true' : 'false',
                className: `sdw-nc-menu-item${selected ? ' selected' : ''}`,
                onClick: () => chooseModel(group, model),
              }, h('span', null, model.name || model.id), selected ? h(IconCheck, null) : null)
            }))),
          visibleGroups.length === 0
            ? h('div', { key: 'empty', className: 'sdw-nc-menu-empty' }, t('modelMenuEmpty'))
            : null,
        ]
      } else {
        body = [
          h('button', {
            key: 'default',
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': effortId ? 'false' : 'true',
            className: `sdw-nc-menu-item${effortId ? '' : ' selected'}`,
            onClick: () => chooseEffort(''),
          }, h('span', null, t('effortDefault')), effortId ? null : h(IconCheck, null)),
          ...efforts.map((effort) => {
            const selected = effort.id === effortId
            return h('button', {
              key: effort.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected ? 'true' : 'false',
              className: `sdw-nc-menu-item${selected ? ' selected' : ''}`,
              onClick: () => chooseEffort(effort.id),
            }, h('span', null, effort.name || effort.id), selected ? h(IconCheck, null) : null)
          }),
        ]
      }
      return h('div', { className: 'sdw-nc-modelctl' },
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: `${className} sdw-nc-model-trigger`,
          disabled: Boolean(disabled) || groups.length === 0,
          title: t('modelSelect'),
          'aria-label': t('modelSelect'),
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: toggle,
        },
          h('span', { className: 'sdw-nc-model-name' }, modelName),
          effortName ? h('span', { className: 'sdw-nc-effort' }, effortName) : null),
        open && pos
          ? h('div', {
            className: 'sdw-nc-modelmenu',
            role: 'menu',
            'data-view': view,
            style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
          }, body)
          : null)
    }

    // --- composer controls (0.10.25) --------------------------------------
    // Presentation mirrors the native InputBar: a permission chip in the tools
    // row that opens a 248px popup above the card (with a risk confirmation for
    // the loosening presets), a "+" menu whose first row picks attachments, an
    // attachment rail above the editor, and a recording bar that replaces the
    // editor while the microphone is active.

    function NcPermissionControl({ options, current, busy, disabled, t, className, onSelect }) {
      const list = Array.isArray(options) ? options : null
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [ack, setAck] = useState(false)
      const triggerRef = useRef(null)
      const label = permissionLabelOf(current, t) || t('permissionLabel')
      const anchor = () => {
        const button = triggerRef.current
        const rect = button ? button.getBoundingClientRect() : null
        if (!rect) return
        const card = button.closest ? button.closest('[data-composer-card]') : null
        const cardRect = card ? card.getBoundingClientRect() : null
        const screenWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
        const screenHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
        setPos({
          left: Math.max(8, Math.min(rect.left, screenWidth - 280)),
          bottom: Math.max(8, screenHeight - (cardRect ? cardRect.top : rect.top) + 6),
        })
      }
      useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (triggerRef.current && triggerRef.current.contains(event.target)) return
          if (event.target && event.target.closest && event.target.closest('.sdw-nc-permmenu')) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', close, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('mousedown', close, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', close)
        }
      }, [open])
      if (!list) {
        // Peer advertises no setter (0.10.24 host or no permission service):
        // keep the chip read-only instead of faking a control.
        return h('button', {
          type: 'button',
          className,
          title: current || label,
          'aria-label': `${t('permissionLabel')} · ${label}`,
          disabled: true,
        },
          h(IconShield, { className: 'sdw-nc-perm-icon' }),
          h('span', null, label),
          h(IconChevron, { className: 'sdw-nc-perm-chevron' }))
      }
      const submit = async (value, confirmed) => {
        if (!onSelect) return
        try { await Promise.resolve(onSelect(value, confirmed === true)) } catch (err) {
          clientDebug('chat', `permission switch failed: ${errorLine(err)}`, 'warn')
        }
      }
      const select = (option) => {
        if (!option || option.value === current) { setOpen(false); return }
        setOpen(false)
        if (PERMISSION_RISK_VALUES.has(option.value)) { setAck(false); setConfirm(option); return }
        void submit(option.value, false)
      }
      const confirmSubmit = () => {
        if (!confirm || !ack) return
        const value = confirm.value
        setConfirm(null)
        void submit(value, true)
      }
      const badge = (value) => (value === 'auto' ? h('span', { className: 'sdw-nc-badge' }, 'EXP') : null)
      return h('div', { className: 'sdw-nc-permctl' },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: `${className} sdw-nc-perm-trigger`,
          'data-perm-trigger': '',
          disabled: Boolean(disabled) || Boolean(busy),
          title: current || label,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `${t('permissionLabel')} · ${label}`,
          onClick: () => {
            if (open) { setOpen(false); return }
            anchor()
            setOpen(true)
          },
        },
          h(IconShield, { className: 'sdw-nc-perm-icon' }),
          h('span', null, busy ? t('permSwitching') : label),
          h(IconChevron, { className: 'sdw-nc-perm-chevron' })),
        open && pos
          ? h('div', {
            className: 'sdw-nc-permmenu',
            role: 'menu',
            'data-permmenu': '',
            style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
          }, list.map((option) => {
            const selected = String(option.value) === String(current)
            return h('button', {
              key: option.value,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected ? 'true' : 'false',
              className: `sdw-nc-perm-item${selected ? ' selected' : ''}`,
              'data-perm-value': String(option.value),
              onClick: () => select(option),
            },
              h('span', { className: 'sdw-nc-perm-item-main' },
                h('span', { className: 'sdw-nc-perm-item-name' }, permissionLabelOf(option.value, t), badge(option.value)),
                option.description ? h('span', { className: 'sdw-nc-perm-item-desc' }, String(option.description)) : null),
              selected ? h(IconCheck, null) : null)
          }))
          : null,
        confirm
          ? h('div', { className: 'sdw-nc-confirm-wrap', 'data-perm-confirm': '' },
            h('div', { className: 'sdw-nc-confirm', role: 'dialog', 'aria-modal': 'true' },
              h('div', { className: 'sdw-nc-confirm-title' },
                t('permRiskTitle').replace('{name}', permissionLabelOf(confirm.value, t))),
              h('div', { className: 'sdw-nc-confirm-body' }, t('permRiskBody')),
              h('label', { className: 'sdw-nc-confirm-ack' },
                h('input', {
                  type: 'checkbox',
                  'data-perm-ack': '',
                  checked: ack,
                  onChange: (event) => setAck(event.target.checked === true),
                }),
                h('span', null, t('permRiskAck'))),
              h('div', { className: 'sdw-nc-confirm-actions' },
                h('button', {
                  type: 'button',
                  className: 'sdw-nc-confirm-btn',
                  'data-perm-confirm-cancel': '',
                  onClick: () => setConfirm(null),
                }, t('permRiskCancel')),
                h('button', {
                  type: 'button',
                  className: 'sdw-nc-confirm-btn danger',
                  'data-perm-confirm-ok': '',
                  disabled: !ack,
                  onClick: confirmSubmit,
                }, t('permRiskConfirm')))))
          : null)
    }

    function NcAddMenu({ t, pos, onFile, onPush, attachAvailable = true }) {
      return h('div', {
        className: 'sdw-nc-addmenu',
        'data-addmenu': '',
        style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
      },
        h('div', { className: 'sdw-nc-menu-label' }, t('addMenuAdd')),
        h('button', {
          type: 'button',
          className: 'sdw-nc-menu-row',
          'data-add-row': '',
          'data-add-file': '',
          disabled: attachAvailable === false,
          title: attachAvailable === false ? t('voiceUnavailable') : undefined,
          onClick: onFile,
        }, h('span', { className: 'sdw-nc-menu-row-label' }, t('addMenuFile'))),
        h('button', {
          type: 'button',
          className: 'sdw-nc-menu-row',
          'data-add-row': '',
          'data-add-push': '',
          onClick: onPush,
        }, h('span', { className: 'sdw-nc-menu-row-label' }, t('addMenuPush'))))
    }

    function NcAttachmentRail({ items, onRemove, t }) {
      if (!Array.isArray(items) || items.length === 0) return null
      return h('div', { className: 'sdw-nc-attachrail', 'data-attach-rail': '' },
        items.map((item) => h('div', {
          key: item.id,
          className: 'sdw-nc-attach',
          'data-attach-item': '',
          'data-state': item.status,
          title: item.name,
        },
          item.preview
            ? h('img', { className: 'sdw-nc-attach-thumb', src: item.preview, alt: item.name })
            : h('span', { className: 'sdw-nc-attach-glyph' },
              h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
                h('path', { d: 'M4 2h5l3 3v9H4z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
                h('path', { d: 'M9 2v3h3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }))),
          h('span', { className: 'sdw-nc-attach-main' },
            h('span', { className: 'sdw-nc-attach-name' }, item.name),
            h('span', { className: 'sdw-nc-attach-sub' },
              item.status === 'staging' ? `${t('attachUploading')} ${item.progress || 0}%`
                : item.status === 'error' ? (item.error || t('attachFailed'))
                  : formatFileSize(item.size))),
          h('button', {
            type: 'button',
            className: 'sdw-nc-attach-remove',
            title: t('attachRemove'),
            'aria-label': t('attachRemove'),
            onClick: () => onRemove?.(item),
          }, '×'))))
    }

    function NcVoiceBar({ voice, t }) {
      const phase = voice?.phase || 'idle'
      const label = phase === 'requesting' ? t('voiceRequesting')
        : phase === 'recording' ? `${t('voiceRecording')} ${clockText(voice.seconds)}`
          : t('voiceTranscribing')
      return h('div', { className: 'sdw-nc-voicebar', 'data-voice-bar': '', 'data-phase': phase },
        h('span', { className: `sdw-nc-voice-dot${phase === 'recording' ? ' on' : ''}` }),
        h('span', { className: 'sdw-nc-voice-label' }, label),
        phase === 'recording' || phase === 'requesting'
          ? h('button', { type: 'button', className: 'sdw-nc-voice-btn', onClick: () => voice?.cancel?.() }, t('voiceCancel'))
          : null,
        phase === 'recording'
          ? h('button', { type: 'button', className: 'sdw-nc-voice-btn primary', onClick: () => voice?.stop?.() }, t('voiceStop'))
          : h(Spinner, null))
    }

    function NcQuestionBody({ model, t }) {
      const T = ncUi().tool
      const pairs = Array.isArray(model?.pairs) ? model.pairs : []
      if (pairs.length === 0) {
        return h('div', { className: T.ioCard },
          h('div', { className: T.ioSection }, h('span', { className: T.ioText }, t('toolEmptyOutput'))))
      }
      return h('div', { className: T.ioCard },
        pairs.map((pair) => h('div', { key: pair.key, className: T.ioSection, 'data-question-pair': '' },
          h('span', { className: T.ioLabel }, pair.title),
          h('span', { className: T.ioText }, pair.answer || t('questionUnanswered')))))
    }

    function NcComposer(props) {
      const ui = ncUi()
      const I = ui.input
      const B = ui.primitives.button || null
      const {
        t, draft, setDraft, send, stop, running, busy, lost, catalog, activeModel, switchModel,
        switchingModel, modelsError, permissions, permissionLabel, permissionValue, onSelectPermission,
        attachments, onFiles, onRemoveAttachment, onPushFiles,
        voice, onVoiceToggle, onVoiceStop, onVoiceCancel, onVoicePrepare, attachAvailable,
      } = props
      const chipClass = B ? `${B.button} ${B.ghost} ${B.sm}` : 'sdw-nc-chip'
      const [addOpen, setAddOpen] = useState(false)
      const [addPos, setAddPos] = useState(null)
      const addRef = useRef(null)
      const fileRef = useRef(null)
      const anchorAdd = () => {
        const button = addRef.current
        const rect = button ? button.getBoundingClientRect() : null
        if (!rect) return
        const card = button.closest ? button.closest('[data-composer-card]') : null
        const cardRect = card ? card.getBoundingClientRect() : null
        const screenWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
        const screenHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
        setAddPos({
          left: Math.max(8, Math.min(rect.left, screenWidth - 260)),
          bottom: Math.max(8, screenHeight - (cardRect ? cardRect.top : rect.top) + 6),
        })
      }
      useEffect(() => {
        if (!addOpen) return undefined
        const close = (event) => {
          if (addRef.current && addRef.current.contains(event.target)) return
          if (event.target && event.target.closest && event.target.closest('.sdw-nc-addmenu')) return
          setAddOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setAddOpen(false) }
        document.addEventListener('mousedown', close, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', close)
        return () => {
          document.removeEventListener('mousedown', close, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', close)
        }
      }, [addOpen])
      const pickedFiles = (event) => {
        const list = event?.target?.files ? Array.from(event.target.files) : []
        if (event) event.target.value = ''
        if (list.length > 0) onFiles?.(list)
      }
      const voiceActive = voice && voice.phase && voice.phase !== 'idle'
      const list = Array.isArray(attachments) ? attachments : []
      const staging = list.some((item) => item.status === 'staging')
      const failed = list.some((item) => item.status === 'error')
      const readyCount = list.filter((item) => item.status === 'ready').length
      const canSend = !busy && !staging && !failed && (draft.trim().length > 0 || readyCount > 0)
      const sendTitle = staging ? t('attachUploading') : failed ? t('attachRetryHint') : t('send')
      const notice = modelsError || (permissions && permissions.error) || (voice && voice.message) || ''
      return h('div', { className: I.root, 'data-shadow-row': 'composer' },
        notice ? h('div', { className: I.notice, role: 'alert' }, notice) : null,
        h('div', { className: I.card, 'data-composer-card': '' },
          h(NcAttachmentRail, { items: list, onRemove: onRemoveAttachment, t }),
          voiceActive
            ? h(NcVoiceBar, { voice, t })
            : h('div', { className: I.scroll, 'data-input-scroll': '' },
              h('div', { className: I.grow },
                h('textarea', {
                  className: `${I.input} sdw-nc-ta`,
                  rows: 1,
                  value: draft,
                  disabled: Boolean(lost),
                  'aria-label': t('inputPlaceholder'),
                  'data-composer-input': '',
                  'aria-multiline': 'true',
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    const composing = Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)
                    if (event.key === 'Enter' && !event.shiftKey && !composing) {
                      event.preventDefault()
                      void send()
                    }
                  },
                }),
                draft ? null : h('div', { className: I.placeholder, 'data-composer-placeholder': '' }, t('inputPlaceholder')))),
          voice && voice.needPrepare && !voiceActive
            ? h('div', { className: 'sdw-nc-voice-hint' },
              h('span', null, voice.prepareStatus || t('voiceUnprepared')),
              h('button', {
                type: 'button',
                disabled: Boolean(voice.preparing),
                onClick: () => onVoicePrepare?.(),
              }, voice.preparing ? t('voicePreparing') : t('voicePrepare')))
            : null,
          h('div', { className: I.row },
            h('div', { className: I.tools },
              h('button', {
                ref: addRef,
                type: 'button',
                className: I.add,
                title: t('inputCommands'),
                'aria-label': t('inputCommands'),
                'aria-haspopup': 'menu',
                'aria-expanded': addOpen ? 'true' : 'false',
                'data-add-trigger': '',
                onClick: () => {
                  if (addOpen) { setAddOpen(false); return }
                  anchorAdd()
                  setAddOpen(true)
                },
              }, h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
                h('path', { d: 'M8 2.5v11M2.5 8h11', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none' }))),
              permissionLabel || (permissions && permissions.options && permissions.options.length)
                ? h(NcPermissionControl, {
                  options: permissions ? permissions.options : null,
                  current: (permissions && permissions.current) || permissionValue || '',
                  busy: Boolean(permissions && permissions.busy),
                  disabled: Boolean(lost),
                  className: chipClass,
                  t,
                  onSelect: onSelectPermission,
                })
                : null),
            h('div', { className: I.trailing },
              h('div', { className: I.standardControls },
                h(NcModelControl, {
                  catalog,
                  value: activeModel,
                  onChange: (next) => void switchModel(next),
                  disabled: switchingModel,
                  t,
                  className: I.select,
                })),
              h('button', {
                type: 'button',
                className: 'sdw-nc-mic',
                title: voice && voice.catalog && voice.catalog.available === false ? t('voiceUnavailable') : t('voiceReady'),
                'aria-label': t('voiceInput'),
                'data-mic': '',
                'data-busy': voiceActive ? '' : undefined,
                disabled: Boolean(lost) || Boolean(busy),
                onClick: () => onVoiceToggle?.(),
              }, h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
                h('path', { d: 'M8 2.4a2.1 2.1 0 0 1 2.1 2.1v3.6a2.1 2.1 0 0 1-4.2 0V4.5A2.1 2.1 0 0 1 8 2.4Z', stroke: 'currentColor', strokeWidth: 1.1, fill: 'none' }),
                h('path', { d: 'M3.9 7.2v.9a4.1 4.1 0 0 0 8.2 0v-.9M8 12.2v1.4', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', fill: 'none' }))),
              running
                ? h('button', {
                  type: 'button',
                  className: I.primary,
                  title: t('stop'),
                  'aria-label': t('stop'),
                  onClick: () => void stop(),
                }, h(IconStop, null))
                : h('button', {
                  type: 'button',
                  className: I.primary,
                  'data-send': '',
                  disabled: !canSend,
                  title: sendTitle,
                  'aria-label': t('send'),
                  onClick: () => void send(),
                }, h(IconSend, null)))),
          addOpen && addPos
            ? h(NcAddMenu, {
              t,
              pos: addPos,
              attachAvailable: attachAvailable !== false,
              onFile: () => {
                setAddOpen(false)
                try { fileRef.current?.click() } catch {}
              },
              onPush: () => {
                setAddOpen(false)
                onPushFiles?.()
              },
            })
            : null,
          h('input', {
            ref: fileRef,
            type: 'file',
            multiple: true,
            hidden: true,
            'data-attach-input': '',
            onChange: pickedFiles,
          })))
    }

    // --- legacy fallback (only when the native classes cannot be discovered)
    function ncLegacySurface(props) {
      const { t, transcript, showEmpty, showSkeleton, running, liveText, liveReasoning, reconnectBanner, cards, draft, setDraft, send, stop, busy, lost, catalog, selectedModel, switchModel, switchingModel, permissionLabel, showJump, jump }
        = props
      const head = h('div', { className: 'sdw-head' },
        h('button', { className: 'sdw-back', onClick: props.onBack }, `← ${t('back')}`),
        h('div', { className: 'sdw-head-main' }, h('h2', { className: 'sdw-title' }, props.sessionTitle), h('div', { className: 'sdw-sub' }, props.sessionMetaLine)))
      const column = h('div', { className: 'sdc-col' },
        showSkeleton ? h(ChatSkeleton, { t }) : null,
        showEmpty ? h(ChatEmpty, { t }) : null,
        transcript.length > 0 ? h('div', { className: 'sdc-flow' }, transcript.map((turn, index) => h(TurnView, { key: turn.key, turn, t, latest: index === transcript.length - 1 }))) : null,
        running && !liveText && !liveReasoning ? h(RunningRow, { t }) : null)
      return h('div', { className: 'sdw-main' },
        head,
        h('div', { className: 'sdc-chat' },
          h('div', { className: 'sdc-scroll', ref: props.listRef, onScroll: props.onScroll }, column),
          showJump ? h('button', { type: 'button', className: 'sdc-toBottom', onClick: jump }, h(IconArrowDown, null)) : null),
        h('div', { className: 'sdc-composer-wrap' }, h('div', { className: 'sdc-composer-inner' }, reconnectBanner, cards,
          h('div', { className: 'sdc-composer' },
            h('textarea', {
              className: 'sdc-input', rows: 1, value: draft, disabled: Boolean(lost),
              placeholder: t('inputPlaceholder'), onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() }
              },
            }),
            h('div', { className: 'sdc-bar' },
              h('div', { className: 'sdc-bar-left' }, permissionLabel ? h('span', { className: 'sdc-perm' }, h(IconShield, null), h('span', null, permissionLabel)) : null),
              h('div', { className: 'sdc-bar-right' },
                h(ModelSelect, { catalog, value: selectedModel, onChange: (next) => void switchModel(next), disabled: switchingModel || !catalog, t, className: 'sdc-select' }),
                running ? h('button', { type: 'button', className: 'sdc-stop', onClick: () => void stop() }, h(IconStop, null))
                  : h('button', { type: 'button', className: 'sdc-send', disabled: busy || !draft.trim(), onClick: () => void send() }, h(IconSend, null))))))))
    }

    function ChatPage({ ctx, t, group, sessionMeta, onBack }) {
      const [frames, setFrames] = useState({ events: [], transient: [] })
      const [approvals, setApprovals] = useState([])
      /** Pending interactive user questions (generic + plan review), 0.8.0. */
      const [questions, setQuestions] = useState([])
      /** Composer capabilities advertised by the peer (0.10.25; additive). */
      const [capabilities, setCapabilities] = useState(null)
      const [attachmentLimits, setAttachmentLimits] = useState(null)
      /** Permission presets: `options === null` keeps the chip read-only. */
      const [permissions, setPermissions] = useState({ options: null, current: '', busy: false, error: '' })
      /** Attachments staged on the peer before the prompt is sent. */
      const [attachments, setAttachments] = useState([])
      /** Voice input state machine (idle → requesting → recording → transcribing). */
      const [voice, setVoice] = useState({
        phase: 'idle', seconds: 0, message: '', catalog: null, available: false,
        usable: false, needPrepare: false, preparing: false, prepareStatus: '',
      })
      const [answeringQuestion, setAnsweringQuestion] = useState('')
      const [questionError, setQuestionError] = useState('')
      const [status, setStatus] = useState(sessionMeta?.status || 'idle')
      const [turnReason, setTurnReason] = useState(null)
      const [lastError, setLastError] = useState('')
      const [lost, setLost] = useState('')
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [answering, setAnswering] = useState('')
      const [liveText, setLiveText] = useState('')
      const [liveReasoning, setLiveReasoning] = useState('')
      const [reconnecting, setReconnecting] = useState(false)
      const [catalog, setCatalog] = useState(null)
      const [modelsError, setModelsError] = useState('')
      const [selectedModel, setSelectedModel] = useState(
        sessionMeta?.model && typeof sessionMeta.model === 'object' ? sessionMeta.model : null,
      )
      const [switchingModel, setSwitchingModel] = useState(false)
      /** First batch applied: switches the loading skeleton to the empty state. */
      const [loaded, setLoaded] = useState(false)
      /** Follow-bottom ownership + the "back to bottom" affordance. */
      const [showJump, setShowJump] = useState(false)
      /** Wall-clock start of the current live reasoning block (for "耗时"). */
      const reasoningStart = useRef(0)
      /** Last user-initiated selection; polled `batch.model` must not revert it. */
      const manualModelAt = useRef(0)
      /** Map transport codes to user-facing text (expired session hint). */
      const describe = useCallback((err) => (
        err && err.code === 'shadow/session-not-found'
          ? t('sessionGone')
          : String((err && err.message) || err)
      ), [t])
      const cursor = useRef({ seq: -1, rev: 0, epoch: '' })
      const alive = useRef(true)
      const polling = useRef(false)
      const abortRef = useRef(null)
      const listRef = useRef(null)
      const draftRef = useRef(null)
      const following = useRef(true)
      /** Transcript column, composer seat and the resolved scrolling ancestor. */
      const flowRef = useRef(null)
      const seatRef = useRef(null)
      const scrollerRef = useRef(null)
      /** Attachment staging identity + the live recording handles. */
      const attachSeq = useRef(0)
      const voiceRef = useRef({ recorder: null, stream: null, chunks: [], timer: null, cancelled: false, startedAt: 0 })
      // Defensive: a slot injector may hand over a session id string (older
      // callers did); never crash the whole page on a missing title/sessionId.
      const sessionId = String(sessionMeta?.sessionId || '')
      const sessionTitle = String(sessionMeta?.title || '') || sessionId.slice(0, 18)

      // Model catalogue: one fetch when the chat opens; models rarely change.
      useEffect(() => {
        let mounted = true
        dataApi('models').then((value) => {
          if (!mounted) return
          setCatalog(value.models || null)
          setModelsError('')
        }).catch((err) => {
          clientDebug('chat', `model catalogue failed: ${errorLine(err)}`, 'warn')
          if (mounted) setModelsError(`${t('modelListFailed')}: ${errorLine(err)}`)
        })
        return () => { mounted = false }
      }, [t])

      // Permission catalog (0.10.25): one read per session. `current` is
      // session-scoped, the durable `permission/preset` frame keeps it fresh.
      useEffect(() => {
        let mounted = true
        dataApi('permissions', { sessionId, op: 'catalog' }).then((value) => {
          if (!mounted) return
          const info = value.permissions || {}
          setPermissions({
            options: Array.isArray(info.options) ? info.options : null,
            current: String(info.current || ''),
            busy: false,
            error: '',
          })
          clientDebug('permission', `catalog options=${Array.isArray(info.options) ? info.options.length : 0}`)
        }).catch((err) => {
          clientDebug('chat', `permission catalogue failed: ${errorLine(err)}`, 'warn')
          if (mounted) setPermissions((prev) => ({ ...prev, options: null, busy: false }))
        })
        return () => { mounted = false }
      }, [sessionId])

      // Voice catalog is local to this machine (the transcription runs on the
      // viewer's Host `speechToText` service, exactly like the native mic).
      useEffect(() => {
        let mounted = true
        dataApi('voice', { op: 'catalog' }).then((value) => {
          if (!mounted) return
          setVoice((prev) => ({ ...prev, catalog: value.voice || null, available: Boolean(value.voice && value.voice.available !== false) }))
        }).catch((err) => {
          clientDebug('chat', `voice catalogue failed: ${errorLine(err)}`, 'warn')
          if (mounted) setVoice((prev) => ({ ...prev, catalog: { available: false, providers: [], selection: null }, available: false }))
        })
        return () => { mounted = false }
      }, [])

      const applySelection = useCallback((selection) => {
        if (!selection || typeof selection !== 'object') return
        if (!selection.provider || !selection.model) return
        setSelectedModel({
          provider: String(selection.provider),
          model: String(selection.model),
          ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
        })
      }, [])

      const switchModel = useCallback(async (next) => {
        if (!next || !next.provider || !next.model) return
        setSwitchingModel(true)
        setModelsError('')
        try {
          const value = await dataApi('select-model', {
            sessionId,
            provider: next.provider,
            model: next.model,
            ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
          })
          manualModelAt.current = Date.now()
          applySelection(value.selected || next)
          clientDebug('chat', `model selection changed provider=${next.provider} model=${next.model}`)
        } catch (err) {
          clientDebug('chat', `model selection failed: ${errorLine(err)}`, 'warn')
          setModelsError(`${t('modelSwitchFailed')}: ${describe(err)}`)
        } finally {
          setSwitchingModel(false)
        }
      }, [applySelection, describe, sessionId, t])

      const mergeBatch = useCallback((batch) => {
        if (!batch || !alive.current) return
        setLoaded(true)
        if (batch.reset) {
          cursor.current = { seq: -1, rev: 0, epoch: batch.epoch || '' }
          setFrames({ events: [], transient: [] })
          setLiveText('')
          setLiveReasoning('')
          reasoningStart.current = 0
          setQuestions([])
        }
        if (batch.epoch) cursor.current.epoch = batch.epoch
        if (typeof batch.status === 'string') setStatus(batch.status)
        if (Array.isArray(batch.approvals)) setApprovals(batch.approvals)
        // The Host is authoritative for which questions are still open; the
        // transient `question` frames below carry the same ids, so applying the
        // batch first and then the frames keeps the list consistent.
        if (Array.isArray(batch.questions)) {
          setQuestions(batch.questions.map(normalizeQuestionRequest).filter(Boolean))
        }
        // 0.10.25 capabilities ride the batch envelope so the composer learns
        // them from its first poll without an extra round trip.
        if (batch.capabilities && typeof batch.capabilities === 'object') setCapabilities(batch.capabilities)
        if (batch.attachmentLimits && typeof batch.attachmentLimits === 'object') setAttachmentLimits(batch.attachmentLimits)
        if (batch.turnReason !== undefined) setTurnReason(batch.turnReason)
        if (batch.lost) setLost(batch.lost)
        if (batch.evicted) setLastError('open-poll limit reached; reopen this session to resume streaming')
        const events = Array.isArray(batch.events) ? batch.events : []
        const transient = Array.isArray(batch.transient) ? batch.transient : []
        if (events.length || transient.length) {
          setFrames((prev) => ({
            events: [...prev.events, ...events].slice(-500),
            transient: [...prev.transient, ...transient].slice(-800),
          }))
          // Diagnostics the B-side debug.log can be checked against: prove the
          // events actually reached the client renderer, per type/batch.
          const counts = {}
          for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1
          for (const frame of transient) {
            const key = `transient:${frame.kind}${frame.phase ? `/${frame.phase}` : ''}`
            counts[key] = (counts[key] || 0) + 1
          }
          const summary = Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(', ')
          clientDebug('chat events', summary.slice(0, 780))
          // Interactive question transients: asked adds, answered/cancelled
          // removes. (The batch questions above already carry the open set.)
          for (const frame of transient) {
            if (frame.kind !== 'question') continue
            if (frame.phase === 'asked') {
              const request = normalizeQuestionRequest(frame)
              if (!request) continue
              setQuestions((prev) => (prev.some((row) => row.questionId === request.questionId)
                ? prev.map((row) => (row.questionId === request.questionId ? request : row))
                : [...prev, request]))
            } else if (frame.phase === 'answered' || frame.phase === 'cancelled') {
              setQuestions((prev) => prev.filter((row) => row.questionId !== frame.questionId))
            }
          }
        }
        // A durable `model/selection` event is authoritative; the polled mirror
        // metadata is only a fallback and must not undo a just-made selection.
        const selection = [...events].reverse().find((event) => event.type === 'model/selection')
        if (selection?.data) applySelection(selection.data)
        else if (batch.model && typeof batch.model === 'object' && Date.now() - manualModelAt.current > 5000) setSelectedModel(batch.model)
        const nextCursor = batch.cursor || {}
        cursor.current.seq = Number.isFinite(Number(nextCursor.seq)) ? Number(nextCursor.seq) : cursor.current.seq
        cursor.current.rev = Number.isFinite(Number(nextCursor.rev)) ? Number(nextCursor.rev) : cursor.current.rev
        if (transient.length) {
          let text = null
          let reasoning = null
          let ended = false
          for (const frame of transient) {
            if (frame.kind !== 'stream') continue
            if (frame.type === 'chunk' && frame.chunk) {
              if (frame.chunk.type === 'text-delta') text = (text || '') + String(frame.chunk.text || '')
              if (frame.chunk.type === 'reasoning-delta') reasoning = (reasoning || '') + String(frame.chunk.text || '')
            }
            if (frame.type === 'end') ended = true
          }
          if (text !== null) setLiveText((prev) => (ended ? '' : (prev + text).slice(-4000)))
          else if (ended) setLiveText('')
          if (reasoning !== null) {
            if (!reasoningStart.current) reasoningStart.current = Date.now()
            setLiveReasoning((prev) => (ended ? '' : (prev + reasoning).slice(-8000)))
            if (ended) reasoningStart.current = 0
          } else if (ended) {
            setLiveReasoning('')
            reasoningStart.current = 0
          }
        }
        if (events.some((event) => event.type === 'assistant/message')) {
          setLiveText('')
          setLiveReasoning('')
          reasoningStart.current = 0
        }
      }, [applySelection])

      const poll = useCallback(async (waitMs) => {
        if (polling.current || !alive.current) return
        polling.current = true
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const value = await dataApi('events', {
            sessionId,
            sinceSeq: cursor.current.seq,
            sinceRev: cursor.current.rev,
            epoch: cursor.current.epoch,
            waitMs,
          }, { signal: controller.signal })
          mergeBatch(value.batch)
          setLastError('')
          setReconnecting(false)
        } catch (err) {
          if (controller.signal.aborted) return
          clientDebug('chat', `request failed: ${errorLine(err)}`, 'warn')
          setLastError(describe(err))
          setReconnecting(true)
        } finally {
          polling.current = false
          if (abortRef.current === controller) abortRef.current = null
        }
      }, [mergeBatch, sessionId])

      useEffect(() => {
        alive.current = true
        clientDebug('chat', `chat page open session=${sessionId}`)
        let timer = null
        const start = () => {
          void dataApi('open', { sessionId }).catch((err) => {
            clientDebug('chat', `open failed: ${errorLine(err)}`, 'warn')
            setLastError(describe(err))
          })
          void poll(300)
          timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            void poll(EVENT_WAIT_MS)
          }, 500)
        }
        start()
        const onVisibility = () => {
          if (typeof document === 'undefined') return
          const hidden = document.visibilityState === 'hidden'
          clientDebug('chat', hidden ? 'page hidden; pausing polls' : 'page visible; resuming polls')
          void dataApi('pause', { paused: hidden }).catch(() => {})
          if (!hidden) void poll(200)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive.current = false
          clientDebug('chat', `chat page close session=${sessionId}`)
          if (timer) clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
          abortRef.current?.abort()
          abortRef.current = null
          void dataApi('close', { sessionId }).catch(() => {})
        }
      }, [poll, sessionId])

      const turns = useMemo(() => buildTranscript(frames.events).turns, [frames.events])
      const transcript = useMemo(() => attachLive(turns, {
        reasoning: liveReasoning,
        text: liveText,
        running: status === 'running' || reconnecting,
        startedAt: reasoningStart.current,
        now: Date.now(),
      }), [liveReasoning, liveText, reconnecting, status, turns])

      const statusInfo = useMemo(() => statusOf({ status, turnReason, lost }, approvals), [approvals, lost, status, turnReason])
      const activeModel = selectedModel || (catalog && catalog.default) || null
      const disconnected = Boolean(lost) || (reconnecting && lastError && status !== 'running')

      // --- native-like scroll follow (0.10.25) ---------------------------
      // The real scroller is whichever ancestor actually overflows: normally
      // ConversationRoot's `[data-conversation-scroll]`, but when the slot host
      // does not bound our height the app shell/window scrolls instead. Resolve
      // it at runtime, re-land after every commit while the reader owns the
      // bottom, and let a real reader gesture unpin it (native threshold: 25px).
      const FOLLOW_THRESHOLD = 25
      const resolveScroller = useCallback(() => {
        const start = listRef.current
        if (!start) return null
        const doc = start.ownerDocument
        const overflows = (node) => Boolean(node) && node.scrollHeight - node.clientHeight > 1
        let node = start
        const body = doc ? doc.body : null
        while (node && node !== body && !overflows(node)) node = node.parentElement
        if (overflows(node)) return node
        if (doc) {
          const root = doc.scrollingElement || doc.documentElement
          if (overflows(root)) return root
        }
        return start
      }, [])

      /** Land on the floor (instant unless `smooth`); safe when nothing scrolls. */
      const scrollToBottom = useCallback((smooth) => {
        const node = resolveScroller()
        if (!node) return
        const floor = Math.max(0, node.scrollHeight - node.clientHeight)
        try { node.scrollTo({ top: floor, behavior: smooth ? 'smooth' : 'auto' }) } catch { node.scrollTop = floor }
      }, [resolveScroller])

      const onScroll = useCallback(() => {
        const node = resolveScroller()
        if (!node) return
        const distance = Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop)
        const near = distance <= FOLLOW_THRESHOLD
        if (following.current !== near) {
          following.current = near
          setShowJump(!near)
        }
      }, [resolveScroller])

      // Every commit lands at the floor while following: this covers streaming
      // text, tool results arriving for an existing row, process-group growth,
      // composer-seat height changes and late layout/reflow.
      useEffect(() => {
        if (following.current) scrollToBottom(false)
      })

      // Growth that does not cause a React commit (images, fonts, async layout)
      // still re-lands through the ResizeObserver / MutationObserver pair.
      useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => {
          if (following.current) scrollToBottom(false)
        })
        for (const node of [flowRef.current, listRef.current, seatRef.current]) {
          if (node) observer.observe(node)
        }
        return () => observer.disconnect()
      }, [loaded, scrollToBottom])

      // Attach the scroll listener to the ancestor that really scrolls.
      useEffect(() => {
        const node = resolveScroller()
        if (!node) return undefined
        scrollerRef.current = node
        const handler = () => onScroll()
        node.addEventListener('scroll', handler, { passive: true })
        try { window.addEventListener('scroll', handler, { passive: true }) } catch {}
        return () => {
          node.removeEventListener('scroll', handler)
          try { window.removeEventListener('scroll', handler) } catch {}
        }
      }, [loaded, onScroll, resolveScroller])

      // Auto-grow the composer textarea up to the native cap.
      useEffect(() => {
        const node = draftRef.current
        if (!node) return
        node.style.height = 'auto'
        node.style.height = `${Math.min(200, Math.max(28, node.scrollHeight))}px`
      }, [draft])

      const send = useCallback(async () => {
        const text = draft.trim()
        if (busy) return
        if (attachments.some((row) => row.status === 'staging')) return
        if (attachments.some((row) => row.status === 'error')) return
        const ready = attachments.filter((row) => row.status === 'ready' && row.transferId)
        if (!text && ready.length === 0) return
        const refs = ready.map((row) => ({ transferId: row.transferId }))
        setBusy(true)
        setDraft('')
        following.current = true
        setShowJump(false)
        scrollToBottom(false)
        try {
          await dataApi('prompt', {
            sessionId,
            text,
            ...(refs.length ? { attachments: refs } : {}),
          })
          for (const row of attachments) {
            if (row.preview) { try { URL.revokeObjectURL(row.preview) } catch {} }
          }
          setAttachments([])
          setStatus('running')
          void poll(200)
        } catch (err) {
          clientDebug('chat', `request failed: ${errorLine(err)}`, 'warn')
          setLastError(describe(err))
          setDraft(text)
        } finally {
          setBusy(false)
        }
      }, [attachments, busy, describe, draft, poll, scrollToBottom, sessionId])

      const stop = useCallback(async () => {
        try {
          await dataApi('cancel', { sessionId })
          void poll(200)
        } catch (err) {
          clientDebug('chat', `request failed: ${errorLine(err)}`, 'warn')
          setLastError(describe(err))
        }
      }, [poll, sessionId])

      const answer = useCallback(async (approval, outcome) => {
        setAnswering(approval.approvalId)
        try {
          await dataApi('answer', { sessionId, approvalId: approval.approvalId, outcome })
          clientDebug('approval', `answered ${approval.approvalId} outcome=${outcome}`)
          setApprovals((prev) => prev.filter((row) => row.approvalId !== approval.approvalId))
        } catch (err) {
          clientDebug('chat', `request failed: ${errorLine(err)}`, 'warn')
          setLastError(describe(err))
        } finally {
          setAnswering('')
        }
      }, [sessionId])

      const submitQuestionAnswers = useCallback(async (request, answers) => {
        setAnsweringQuestion(request.questionId)
        setQuestionError('')
        try {
          await dataApi('answer-question', {
            sessionId,
            questionId: request.questionId,
            answers,
          })
          // 0.10.25: the answer is confirmed by the durable `ask_user_question`
          // tool result; no local "已回答" card is pinned above the composer.
          setQuestions((prev) => prev.filter((row) => row.questionId !== request.questionId))
          clientDebug('question', `answered ${request.questionId} answers=${answers.length}`)
          void poll(200)
        } catch (err) {
          clientDebug('question', `answer failed: ${errorLine(err)}`, 'warn')
          setQuestionError(`${t('questionBadAnswer')}: ${describe(err)}`)
        } finally {
          setAnsweringQuestion('')
        }
      }, [describe, poll, sessionId, t])

      const cancelQuestion = useCallback(async (request) => {
        setAnsweringQuestion(request.questionId)
        setQuestionError('')
        try {
          await dataApi('answer-question', {
            sessionId,
            questionId: request.questionId,
            cancel: true,
            reason: 'modify-requested',
          })
          setQuestions((prev) => prev.filter((row) => row.questionId !== request.questionId))
          clientDebug('question', `changes requested ${request.questionId}`)
          void poll(200)
        } catch (err) {
          clientDebug('question', `cancel failed: ${errorLine(err)}`, 'warn')
          setQuestionError(`${t('questionBadAnswer')}: ${describe(err)}`)
        } finally {
          setAnsweringQuestion('')
        }
      }, [describe, poll, sessionId, t])

      // --- composer attachments (0.10.25) --------------------------------
      // Bytes are staged on the sharing host in 512 KiB chunks (the peer RPC
      // body is capped at 1 MB); the prompt then references the transfer ids so
      // the host can inline images / mint file receipts itself.
      const stageAttachment = useCallback(async (file) => {
        if (!file || typeof file.arrayBuffer !== 'function') return
        const limits = attachmentLimits || {}
        const maxBytes = Number(limits.maxBytes) || ATTACH_DEFAULT_MAX
        const maxCount = Number(limits.maxAttachments) || ATTACH_MAX_FILES
        const kind = attachmentKindOf(file)
        const id = `att-${++attachSeq.current}`
        const preview = kind === 'image' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file) : ''
        const item = {
          id,
          name: String(file.name || 'file'),
          size: Number(file.size) || 0,
          kind,
          mediaType: String(file.type || '') || (kind === 'image' ? 'image/png' : 'application/octet-stream'),
          preview,
          status: 'staging',
          progress: 0,
          transferId: '',
          error: '',
        }
        let accepted = true
        setAttachments((prev) => {
          if (prev.length >= maxCount) { accepted = false; return prev }
          return [...prev, item]
        })
        if (!accepted) {
          if (preview) { try { URL.revokeObjectURL(preview) } catch {} }
          setLastError(t('attachTooMany'))
          return
        }
        if (item.size > maxBytes) {
          setAttachments((prev) => prev.map((row) => (row.id === id ? { ...row, status: 'error', error: t('attachTooLarge') } : row)))
          return
        }
        try {
          const begin = await dataApi('attach', {
            sessionId,
            step: 'begin',
            kind,
            name: item.name,
            size: item.size,
            mediaType: item.mediaType,
          })
          const info = begin.attach || {}
          const transferId = String(info.transferId || '')
          const chunkBytes = Number(info.chunkBytes) || ATTACH_DEFAULT_CHUNK
          const buffer = await file.arrayBuffer()
          const chunks = uploadChunksOf(buffer, chunkBytes)
          for (let index = 0; index < chunks.length; index += 1) {
            await dataApi('attach', { sessionId, step: 'chunk', transferId, index, data: chunks[index] })
            const progress = Math.round(((index + 1) / chunks.length) * 100)
            setAttachments((prev) => prev.map((row) => (row.id === id ? { ...row, progress } : row)))
          }
          const commit = await dataApi('attach', { sessionId, step: 'commit', transferId })
          const facts = commit.attach || {}
          setAttachments((prev) => prev.map((row) => (row.id === id
            ? { ...row, status: 'ready', progress: 100, transferId: String(facts.transferId || transferId) }
            : row)))
        } catch (err) {
          clientDebug('chat', `attachment staging failed: ${errorLine(err)}`, 'warn')
          setAttachments((prev) => prev.map((row) => (row.id === id ? { ...row, status: 'error', error: describe(err) } : row)))
        }
      }, [attachmentLimits, describe, sessionId, t])

      const onFiles = useCallback((files) => {
        for (const file of Array.isArray(files) ? files : []) void stageAttachment(file)
      }, [stageAttachment])

      const removeAttachment = useCallback((item) => {
        if (!item) return
        setAttachments((prev) => prev.filter((row) => row.id !== item.id))
        if (item.preview) { try { URL.revokeObjectURL(item.preview) } catch {} }
        if (item.transferId) {
          void dataApi('attach', { sessionId, step: 'abort', transferId: item.transferId }).catch(() => {})
        }
      }, [sessionId])

      const openPushFiles = useCallback(() => {
        try { ctx?.layout?.selectPanel?.(SETTINGS_KEY) } catch {}
      }, [ctx])

      // --- permission presets (0.10.25) ----------------------------------
      const selectPermission = useCallback(async (value, confirmed) => {
        setPermissions((prev) => ({ ...prev, busy: true, error: '' }))
        try {
          const result = await dataApi('permissions', {
            sessionId,
            op: 'set',
            preset: value,
            confirmed: confirmed === true,
          })
          const info = result.permissions || {}
          setPermissions((prev) => ({ ...prev, busy: false, current: String(info.current || value) }))
          clientDebug('permission', `preset ${value} confirmed=${confirmed === true}`)
          void poll(200)
        } catch (err) {
          clientDebug('chat', `permission switch failed: ${errorLine(err)}`, 'warn')
          setPermissions((prev) => ({ ...prev, busy: false, error: `${t('permSwitchFailed')}: ${describe(err)}` }))
        }
      }, [describe, poll, sessionId, t])

      // --- voice input (0.10.25) -----------------------------------------
      // The recording is captured in this browser and transcribed by this
      // machine's own Host `speechToText` service (native's channel), so it
      // never crosses the peer protocol.
      const voiceUsable = useCallback((catalog) => {
        if (!catalog || catalog.available === false) return false
        const selected = catalog.selection?.providerId
        const provider = (catalog.providers || []).find((row) => row && row.id === selected) || (catalog.providers || [])[0]
        const phase = provider?.preparation?.phase
        return phase === 'ready' || phase === 'standby' || phase === 'waking'
      }, [])

      const releaseVoice = useCallback(() => {
        const state = voiceRef.current
        if (state?.timer) { clearInterval(state.timer); state.timer = null }
        try { state?.stream?.getTracks?.().forEach((track) => track.stop()) } catch {}
      }, [])

      const resetVoice = useCallback((patch) => {
        setVoice((prev) => ({ ...prev, phase: 'idle', seconds: 0, ...(patch || {}) }))
      }, [])

      useEffect(() => () => {
        const state = voiceRef.current
        if (state?.timer) clearInterval(state.timer)
        try { state?.stream?.getTracks?.().forEach((track) => track.stop()) } catch {}
      }, [])

      const stopVoice = useCallback(async () => {
        const state = voiceRef.current
        if (!state?.recorder || state.stopping === true) return
        state.stopping = true
        if (state.timer) { clearInterval(state.timer); state.timer = null }
        const recorder = state.recorder
        await new Promise((resolve) => {
          try {
            recorder.onstop = () => resolve()
            recorder.stop()
          } catch { resolve() }
        })
        try { state.stream?.getTracks?.().forEach((track) => track.stop()) } catch {}
        if (state.cancelled === true) { resetVoice(); return }
        setVoice((prev) => ({ ...prev, phase: 'transcribing' }))
        try {
          const blob = new Blob(state.chunks, { type: recorder.mimeType || 'audio/webm' })
          const AudioCtx = window.AudioContext || window.webkitAudioContext
          if (!AudioCtx) throw new Error(t('voiceUnsupported'))
          const audioContext = new AudioCtx()
          let wav
          try {
            const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer())
            wav = await resampleToWav16k(decoded, Number(voice.catalog?.maxDurationSeconds) || VOICE_MAX_SECONDS)
          } finally {
            try { await audioContext.close?.() } catch {}
          }
          const value = await dataApi('voice', {
            op: 'transcribe',
            audioBase64: bytesToBase64(wav),
            providerId: voice.catalog?.selection?.providerId,
            language: voice.catalog?.selection?.language,
          }, { headers: { 'x-shadow-action': 'voice' } })
          const text = String(value?.voice?.text || '').trim()
          if (!text) { resetVoice({ message: t('voiceEmpty') }); return }
          setDraft((prev) => {
            const base = String(prev || '')
            return base ? (/\s$/.test(base) ? base + text : `${base} ${text}`) : text
          })
          resetVoice()
          clientDebug('voice', `transcribed ${text.length} chars`)
        } catch (err) {
          clientDebug('chat', `voice transcribe failed: ${errorLine(err)}`, 'warn')
          resetVoice({ message: `${t('voiceFailed')}${describe(err)}` })
        } finally {
          voiceRef.current = { recorder: null, stream: null, chunks: [], timer: null, cancelled: false, startedAt: 0 }
        }
      }, [describe, resetVoice, t, voice.catalog])

      const startVoice = useCallback(async () => {
        if (voice.phase !== 'idle') return
        const catalog = voice.catalog
        if (!catalog || catalog.available === false) {
          setVoice((prev) => ({ ...prev, message: t('voiceUnavailable') }))
          return
        }
        if (!voiceUsable(catalog)) {
          setVoice((prev) => ({ ...prev, message: '', needPrepare: true }))
          return
        }
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function'
          || typeof window.MediaRecorder === 'undefined') {
          setVoice((prev) => ({ ...prev, message: t('voiceUnsupported') }))
          return
        }
        setVoice((prev) => ({ ...prev, phase: 'requesting', seconds: 0, message: '' }))
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
          const recorder = new window.MediaRecorder(stream)
          const chunks = []
          recorder.ondataavailable = (event) => {
            if (event && event.data && event.data.size > 0) chunks.push(event.data)
          }
          recorder.onerror = () => {
            releaseVoice()
            resetVoice({ message: t('voiceInterrupted') })
          }
          recorder.start()
          const startedAt = Date.now()
          voiceRef.current = { recorder, stream, chunks, timer: null, cancelled: false, startedAt }
          const maxSeconds = Number(catalog.maxDurationSeconds) || VOICE_MAX_SECONDS
          voiceRef.current.timer = setInterval(() => {
            const seconds = Math.floor((Date.now() - startedAt) / 1000)
            setVoice((prev) => ({ ...prev, seconds }))
            if (seconds >= maxSeconds) void stopVoice()
          }, 500)
          setVoice((prev) => ({ ...prev, phase: 'recording', seconds: 0 }))
        } catch (err) {
          releaseVoice()
          const name = String(err?.name || '')
          const message = name === 'NotAllowedError' ? t('voiceDenied')
            : name === 'NotFoundError' || name === 'OverconstrainedError' ? t('voiceNoDevice')
              : `${t('voiceFailed')}${String(err?.message || err)}`
          voiceRef.current = { recorder: null, stream: null, chunks: [], timer: null, cancelled: false, startedAt: 0 }
          resetVoice({ message })
        }
      }, [releaseVoice, resetVoice, stopVoice, t, voice.catalog, voice.phase, voiceUsable])

      const cancelVoice = useCallback(() => {
        const state = voiceRef.current
        if (!state?.recorder) { resetVoice(); return }
        state.cancelled = true
        if (state.timer) { clearInterval(state.timer); state.timer = null }
        try { state.recorder.stop() } catch {}
        try { state.stream?.getTracks?.().forEach((track) => track.stop()) } catch {}
        voiceRef.current = { recorder: null, stream: null, chunks: [], timer: null, cancelled: false, startedAt: 0 }
        resetVoice()
      }, [resetVoice])

      const toggleVoice = useCallback(() => {
        if (voice.phase === 'recording') void stopVoice()
        else if (voice.phase === 'requesting') cancelVoice()
        else if (voice.phase === 'idle') {
          if (voice.message) setVoice((prev) => ({ ...prev, message: '' }))
          void startVoice()
        }
      }, [cancelVoice, startVoice, stopVoice, voice.message, voice.phase])

      const prepareVoice = useCallback(async () => {
        const catalog = voice.catalog
        const providerId = catalog?.selection?.providerId || catalog?.providers?.[0]?.id
        if (!providerId) return
        setVoice((prev) => ({ ...prev, preparing: true, message: '', prepareStatus: t('voicePreparing') }))
        try {
          await dataApi('voice', { op: 'prepare', providerId })
        } catch (err) {
          setVoice((prev) => ({ ...prev, preparing: false, prepareStatus: `${t('voiceFailed')}${describe(err)}` }))
          return
        }
        const startedAt = Date.now()
        const tick = async () => {
          try {
            const value = await dataApi('voice', { op: 'catalog' })
            const next = value.voice
            const usable = voiceUsable(next)
            setVoice((prev) => ({
              ...prev,
              catalog: next || prev.catalog,
              available: Boolean(next && next.available !== false),
              usable,
              needPrepare: Boolean(next && next.available !== false && !usable),
              preparing: !usable,
              prepareStatus: usable ? '' : t('voicePreparing'),
            }))
            if (!usable && Date.now() - startedAt < 10 * 60 * 1000) { setTimeout(tick, 2000); return }
            if (usable) setVoice((prev) => ({ ...prev, message: '' }))
          } catch {
            if (Date.now() - startedAt < 10 * 60 * 1000) setTimeout(tick, 3000)
          }
        }
        setTimeout(tick, 1200)
      }, [describe, t, voice.catalog, voiceUsable])

      const ui = ncUi()
      const rootRef = useRef(null)
      const bodyRef = useRef(null)
      // Native column axis: content width = clamp(680, bodyWidth * .64, 920).
      // The shell writes --dsh-conversation-column-width on the body's parent and
      // the body derives --dsh-chat-content-width / composer card width from it.
      useEffect(() => {
        const root = rootRef.current
        const body = bodyRef.current
        if (!root || !body) return undefined
        const sync = () => {
          const width = body.offsetWidth || root.offsetWidth || 0
          if (width > 0) root.style.setProperty('--dsh-conversation-column-width', width + 'px')
        }
        sync()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
        if (observer) observer.observe(body)
        else window.addEventListener('resize', sync)
        return () => {
          if (observer) observer.disconnect()
          else window.removeEventListener('resize', sync)
        }
      })

      const running = status === 'running'
      const waiting = statusInfo.kind === 'waiting'
      const showEmpty = loaded && transcript.length === 0 && !running && !liveText && !liveReasoning
      const showSkeleton = !loaded
      const sessionMetaLine = [t(statusInfo.key), group.deviceName].filter(Boolean).join(' · ')
      const permissionValue = (() => {
        let preset = ''
        let mode = ''
        for (const event of frames.events) {
          if (event?.type === 'permission/preset' && event.data?.preset) preset = String(event.data.preset)
          else if (event?.type === 'sandbox/mode' && event.data?.mode) mode = String(event.data.mode)
        }
        return preset || mode
      })()
      const permissionCurrent = permissions.current || permissionValue
      const permissionLabel = permissionLabelOf(permissionCurrent, t)
      const jump = () => {
        following.current = true
        setShowJump(false)
        scrollToBottom(true)
      }
      const reconnectBanner = disconnected
        ? h('div', { className: 'sdw-nc-banner', role: 'status' },
          h(IconAlert, null),
          h('span', null, lost ? t('statusLost') : `${t('statusDisconnected')}${lastError ? ` · ${lastError}` : ''}`),
          h('button', { type: 'button', className: 'sdw-nc-link', onClick: () => { setReconnecting(false); void poll(200) } }, t('reconnect')))
        : null
      const attention = h('div', { className: 'sdw-nc-attention' },
        questions.map((request) => h(QuestionCard, {
          key: request.questionId,
          request,
          busy: answeringQuestion === request.questionId,
          disabled: Boolean(answeringQuestion) && answeringQuestion !== request.questionId,
          onSubmit: (answers) => void submitQuestionAnswers(request, answers),
          onCancelQuestion: (target) => void cancelQuestion(target),
          t,
        })),
        approvals.map((approval) => h(ApprovalCard, {
          key: `ap-${approval.approvalId}`,
          approval,
          busy: answering === approval.approvalId,
          onAnswer: answer,
          t,
        })))

      if (!ui) {
        return ncLegacySurface({
          t,
          transcript,
          showEmpty,
          showSkeleton,
          running,
          liveText,
          liveReasoning,
          lastError,
          disconnected,
          reconnectBanner,
          cards: attention,
          draft,
          setDraft,
          send,
          stop,
          busy,
          lost,
          catalog,
          selectedModel,
          switchModel,
          switchingModel,
          modelsError,
          permissionLabel,
          permissionValue,
          showJump,
          jump,
          onBack,
          sessionTitle,
          sessionMetaLine,
          listRef,
          onScroll,
        })
      }

      const C = ui.conversation
      const V = ui.view
      const A = ui.iconActions
      const flow = []
      transcript.forEach((turn, index) => {
        const nodes = NcTurn({ turn, t, latest: index === transcript.length - 1, live: running && index === transcript.length - 1 })
        for (const node of nodes) flow.push(node)
      })
      if (running) {
        flow.push(h(NcRunningTail, { key: 'running-tail', t }))
      }
      const column = h('div', { className: V.column, 'data-chat-flow': '', ref: flowRef },
        modelsError ? h('div', { className: 'sdw-nc-banner sdw-nc-banner-error', role: 'alert' }, modelsError) : null,
        showSkeleton ? h(ChatSkeleton, { t }) : null,
        showEmpty ? h(ChatEmpty, { t }) : null,
        flow,
        lastError && !disconnected
          ? h('div', { className: 'sdw-nc-banner sdw-nc-banner-error', role: 'alert' }, lastError)
          : null)
      const chat = h('div', { className: V.root, 'data-chat-root': '' },
        h('div', { className: V.scroll },
          column),
        showJump
          ? h('div', { className: V.toBottomSlot },
            h('button', {
              type: 'button',
              className: V.toBottom,
              'data-to-bottom': '',
              title: t('toBottom'),
              'aria-label': t('toBottom'),
              onClick: jump,
            }, h(IconArrowDown, null)))
          : null)
      const head = h('div', { className: C.header, 'data-window-drag': '', 'data-shadow-row': 'header' },
        h('div', { className: C.headerLeading }),
        h('div', { className: C.titleRow },
          h('div', { className: C.titleCluster },
            h('nav', { className: C.crumbs, 'aria-label': sessionTitle },
              h('span', { className: C.crumbSeg },
                h('span', { className: `${C.crumb} ${C.crumbCurrent}` }, sessionTitle))),
            h('div', { className: C.headerActions },
              h('span', { className: 'sdw-nc-status' },
                h(Dot, { dot: statusInfo.dot }),
                h('span', null, sessionMetaLine),
                waiting ? h('span', { className: 'sdw-nc-status-waiting' }, t('statusWaiting')) : null)))))
      const composerSeat = h('div', { className: C.composerSeat, 'data-composer-seat': '', 'data-conversation-region': 'composer', ref: seatRef },
        h('div', { className: C.composerStack },
          reconnectBanner,
          attention,
          h(NcComposer, {
            t,
            draft,
            setDraft,
            send,
            stop,
            running,
            busy,
            lost,
            catalog,
            activeModel,
            switchModel,
            switchingModel,
            modelsError,
            permissions,
            permissionLabel,
            permissionValue,
            onSelectPermission: selectPermission,
            attachments,
            onFiles,
            onRemoveAttachment: removeAttachment,
            onPushFiles: openPushFiles,
            voice,
            onVoiceToggle: toggleVoice,
            onVoiceStop: stopVoice,
            onVoiceCancel: cancelVoice,
            onVoicePrepare: prepareVoice,
            attachAvailable: !capabilities || capabilities.attachments !== false,
          })))
      return h('div', {
        className: C.root,
        ref: rootRef,
        'data-phase': 'active',
        'data-shadow-row': 'chat-page',
        style: {
          flex: '1 1 auto',
          width: '100%',
          minWidth: 0,
          '--dsh-conversation-column-width': `${Math.max(640, (typeof window !== 'undefined' ? window.innerWidth : 1440) - 320)}px`,
        },
      },
        head,
        h('div', { className: C.body, ref: bodyRef, 'data-conversation-content': '', 'data-conversation-region': 'chat' },
          h('div', {
            className: C.scrollBody,
            'data-conversation-scroll': '',
            ref: listRef,
            onScroll,
          },
            h('div', { className: C.viewArea, 'data-conversation-region': 'view' }, chat),
            composerSeat)))
    }




    // -----------------------------------------------------------------------
    // Sidebar entries
    // -----------------------------------------------------------------------

    function ShadowIcon(props) {
      const size = props && props.size ? props.size : 16
      return h('span', { style: { display: 'inline-flex' }, 'data-dsh-plugin': 'dsh-plugin-shadow-workspace', 'data-dsh-part': 'sidebar-icon' },
        h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        },
          h('rect', { x: 2.5, y: 4.5, width: 12, height: 9, rx: 1.5 }),
          h('path', { d: 'M6 20h5' }),
          h('path', { d: 'M8.5 13.5V20' }),
          h('rect', { x: 15.5, y: 9.5, width: 6, height: 9, rx: 1.2, strokeDasharray: '2.4 2.2' })))
    }

    function makeGroupId(group) {
      return `${GROUP_PREFIX}${group.deviceId}/${group.workspaceId}`
    }

    const inject = ['slots', 'layout', 'locale']

    function apply(ctx) {
      ensureStyle()
      clientDebug('apply', 'client plugin apply start')
      const locale = ctx.get('locale')
      try {
        ctx.effect(() => locale.register(NS, { zh, en }), 'shadow-workspace: dictionaries')
      } catch {}
      let bound = null
      try {
        bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : null
      } catch {}
      const t = (key) => {
        if (bound) {
          try { return bound(key) } catch {}
        }
        return zh[key] || key
      }
      let ready = false
      let latest = null
      const entries = new Map()

      const disposeEntry = (groupId) => {
        const entry = entries.get(groupId)
        if (!entry) return
        entries.delete(groupId)
        try { entry.stopIcon?.() } catch {}
        try { entry.stopPanel?.() } catch {}
      }
      const disposeAll = () => {
        for (const groupId of [...entries.keys()]) disposeEntry(groupId)
      }
      const registerSettings = () => {
        if (entries.has(SETTINGS_KEY)) return
        const stopPanel = ctx.slots.register({
          name: 'main',
          key: SETTINGS_KEY,
          inject: () => ({ ctx, t }),
        }, ShadowApp)
        entries.set(SETTINGS_KEY, { stopPanel, stopIcon: null })
        clientDebug('slot', `registered main key=${SETTINGS_KEY} (sidebar row hidden; launcher is the entry)`)
      }
      const syncEntries = () => {
        if (!ready) return
        registerSettings()
      }
      const refresh = async () => {
        try {
          const value = await panelApi('')
          syncEntries(value.state)
        } catch (error) {
          clientDebug('panel', `panel refresh failed: ${errorLine(error)}`, 'warn')
          syncEntries({ sync: { available: false }, display: { groups: [] } })
        }
      }
      /**
       * Native DSH workspace-list replica, pinned above the sidebar footer.
       *
       * The block is rebuilt from the same DOM/CSS contract as
       * `@deepseek-ai/dsh-client-ui-workspace` (project row 34px / session row
       * 32px / section header 36px / overflow row 28px, folder→chevron on hover,
       * row actions revealed on hover, per-workspace collapse, 5-session
       * watermark). Hashed class names are discovered from the live stylesheets
       * so the replica keeps matching the running build; exact icon geometry is
       * taken from `@deepseek-ai/dsh-client-ui-primitives`.
       */
      const mountLauncher = (externalHost) => {
        if (typeof document === 'undefined' || !document.body) return
        let mode = externalHost ? 'inline' : 'fixed'
        const host = externalHost || document.createElement('div')
        if (externalHost) {
          host.className = 'sdw-launch-host sdw-launch-flow'
        } else {
          host.className = 'sdw-launch-host sdw-launch-fixed'
          document.body.appendChild(host)
        }

        const openRoute = (route) => {
          activeSessionId = route && route.sessionId ? String(route.sessionId) : null
          try { window.__shadowRoute = route } catch {}
          try { window.dispatchEvent(new CustomEvent('shadow:route', { detail: route })) } catch {}
          try { ctx?.layout?.selectPanel?.(SETTINGS_KEY) } catch {}
          render()
        }

        const SESSION_PREVIEW = 5
        const STORE_KEY = 'sdw-launch-collapsed-groups'
        const expandedGroups = new Set()
        const collapsedGroups = new Set()
        let state = null
        let timer = 0
        let frame = 0
        let signature = ''
        let activeSessionId = null
        let classes = null
        let browser = null
        let dots = null
        let menuNode = null
        let menuDispose = null
        let hoverNode = null
        let hoverTimer = 0
        let toastNode = null
        let toastTimer = 0
        let disposed = false

        try {
          const stored = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]')
          if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string') collapsedGroups.add(key)
        } catch {}

        const el = (tag, className, text) => {
          const node = document.createElement(tag)
          if (className) node.className = className
          if (text !== undefined) node.textContent = text
          return node
        }
        const svgNS = 'http://www.w3.org/2000/svg'
        // Exact 16x16 icon geometry from @deepseek-ai/dsh-client-ui-primitives.
        const ICONS = {
          folderOpen: [
            { d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: '0.16' },
            { d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', stroke: 'currentColor' },
            { d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', stroke: 'currentColor' },
          ],
          folderClose: [
            { d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z', stroke: 'currentColor' },
            { d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' },
          ],
          triangle: [
            { d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z', fill: 'currentColor' },
          ],
          ellipsis: [
            { d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z', fill: 'currentColor' },
            { d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z', fill: 'currentColor' },
            { d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z', fill: 'currentColor' },
          ],
          newChat: [
            { d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337', stroke: 'currentColor' },
            { d: 'M8 5V11', stroke: 'currentColor' },
            { d: 'M5 8H11', stroke: 'currentColor' },
          ],
          settings: [
            { d: 'M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z', stroke: 'currentColor' },
            { d: 'M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z', stroke: 'currentColor', miterlimit: '10' },
          ],
          refresh: [
            { d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1', stroke: 'currentColor' },
            { d: 'M14.4999 1.5V5.1H10.8999', stroke: 'currentColor' },
          ],
        }
        const icon = (name, size, className) => {
          const geometry = ICONS[name]
          const length = size || 16
          const node = document.createElementNS(svgNS, 'svg')
          node.setAttribute('width', String(length))
          node.setAttribute('height', String(length))
          node.setAttribute('viewBox', '0 0 16 16')
          node.setAttribute('fill', 'none')
          node.setAttribute('aria-hidden', 'true')
          node.setAttribute('stroke-width', '1')
          if (className) node.setAttribute('class', className)
          for (const def of geometry) {
            const path = document.createElementNS(svgNS, 'path')
            path.setAttribute('d', def.d)
            path.setAttribute('fill', def.fill || 'none')
            path.setAttribute('stroke', def.stroke || 'none')
            if (def.opacity) path.setAttribute('opacity', def.opacity)
            if (def.miterlimit) path.setAttribute('stroke-miterlimit', def.miterlimit)
            node.appendChild(path)
          }
          return node
        }

        // --- live stylesheet import: reuse the native classes -----------------
        const collectSelectors = () => {
          let text = ''
          const walk = (rules) => {
            for (const rule of rules) {
              if (rule.selectorText) text += rule.selectorText + '{}'
              else if (rule.cssRules) walk(rule.cssRules)
            }
          }
          for (const sheet of Array.from(document.styleSheets || [])) {
            let rules = null
            try { rules = sheet.cssRules } catch {}
            if (rules) walk(rules)
          }
          return text
        }
        const discover = () => {
          let text = ''
          try { text = collectSelectors() } catch { text = '' }
          if (!text) return null
          const prefixFor = (marker) => {
            const match = new RegExp('\\.([A-Za-z][A-Za-z0-9_-]*)_' + marker + '(?![A-Za-z0-9_-])').exec(text)
            return match ? match[1] : null
          }
          const rowsPrefix = prefixFor('projectRow')
          const browserPrefix = prefixFor('sectionHeader')
          if (!rowsPrefix || !browserPrefix) return null
          const pick = (prefix, name) => prefix + '_' + name
          const rows = {
            projectRow: pick(rowsPrefix, 'projectRow'),
            sessionRow: pick(rowsPrefix, 'sessionRow'),
            selected: pick(rowsPrefix, 'selected'),
            menuOpen: pick(rowsPrefix, 'menuOpen'),
            slot: pick(rowsPrefix, 'slot'),
            folder: pick(rowsPrefix, 'folder'),
            folderActive: pick(rowsPrefix, 'folderActive'),
            chevron: pick(rowsPrefix, 'chevron'),
            projectText: pick(rowsPrefix, 'projectText'),
            title: pick(rowsPrefix, 'title'),
            rowActions: pick(rowsPrefix, 'rowActions'),
            iconButton: pick(rowsPrefix, 'iconButton'),
            arrow: pick(rowsPrefix, 'arrow'),
            arrowOpen: pick(rowsPrefix, 'arrowOpen'),
            time: pick(rowsPrefix, 'time'),
            pinIndicator: pick(rowsPrefix, 'pinIndicator'),
            visuallyHidden: pick(rowsPrefix, 'visuallyHidden'),
            dot: pick(rowsPrefix, 'dot'),
          }
          const browser = {
            sectionHeader: pick(browserPrefix, 'sectionHeader'),
            sectionLabel: pick(browserPrefix, 'sectionLabel'),
            headerActions: pick(browserPrefix, 'headerActions'),
            iconButton: pick(browserPrefix, 'iconButton'),
            groupSection: pick(browserPrefix, 'groupSection'),
            flatList: pick(browserPrefix, 'flatList'),
            sessionOverflowButton: pick(browserPrefix, 'sessionOverflowButton'),
            empty: pick(browserPrefix, 'empty'),
          }
          // StateDot lives in the primitives bundle: `_dot_<hash>_2` style names.
          const arc = /\._(spinnerArc)_([A-Za-z0-9]+)_\d+/.exec(text)
          let stateDots = null
          if (arc) {
            const hash = arc[2]
            const grab = (name) => {
              const found = new RegExp('\\.(_' + name + '_' + hash + '_\\d+)').exec(text)
              return found ? found[1] : null
            }
            stateDots = {
              dot: grab('dot'),
              spinner: grab('spinner'),
              spinnerMotion: grab('spinnerMotion'),
              spinnerTrack: grab('spinnerTrack'),
              spinnerArc: grab('spinnerArc'),
            }
          }
          return { rows, browser, dots: stateDots }
        }
        const fallbackClasses = () => ({
          rows: {
            projectRow: 'sdw-fb-projectRow',
            sessionRow: 'sdw-fb-sessionRow',
            selected: 'sdw-fb-selected',
            menuOpen: 'sdw-fb-menuOpen',
            slot: 'sdw-fb-slot',
            folder: 'sdw-fb-folder',
            folderActive: 'sdw-fb-folderActive',
            chevron: 'sdw-fb-chevron',
            projectText: 'sdw-fb-projectText',
            title: 'sdw-fb-title',
            rowActions: 'sdw-fb-rowActions',
            iconButton: 'sdw-fb-iconButton',
            arrow: 'sdw-fb-arrow',
            arrowOpen: 'sdw-fb-arrowOpen',
            time: 'sdw-fb-time',
            pinIndicator: 'sdw-fb-pinIndicator',
            visuallyHidden: 'sdw-fb-visuallyHidden',
            dot: 'sdw-fb-dot',
          },
          browser: {
            sectionHeader: 'sdw-fb-sectionHeader',
            sectionLabel: 'sdw-fb-sectionLabel',
            headerActions: 'sdw-fb-headerActions',
            iconButton: 'sdw-fb-headerIconButton',
            groupSection: 'sdw-fb-groupSection',
            flatList: 'sdw-fb-flatList',
            sessionOverflowButton: 'sdw-fb-sessionOverflowButton',
            empty: 'sdw-fb-empty',
          },
          dots: {
            dot: 'sdw-fb-dot',
            spinner: 'sdw-fb-spinner',
            spinnerMotion: 'sdw-fb-spinnerMotion',
            spinnerTrack: 'sdw-fb-spinnerTrack',
            spinnerArc: 'sdw-fb-spinnerArc',
          },
        })
        const ensureClasses = () => {
          if (classes) return classes
          const found = discover()
          const value = found || fallbackClasses()
          classes = value.rows
          dots = value.dots
          browser = value.browser
          return classes
        }

        const groupKey = (group) => `${group.deviceId || ''}/${group.workspaceId || ''}`
        const nativeTimeLabel = (iso) => {
          const ms = Date.parse(iso || '')
          if (!Number.isFinite(ms)) return ''
          const diff = Math.max(0, Date.now() - ms)
          if (diff < 60_000) return t('timeNow')
          if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}${t('unitMinutes')}`
          if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}${t('unitHours')}`
          if (diff < 86_400_000 * 30) return `${Math.floor(diff / 86_400_000)}${t('unitDays')}`
          if (diff < 86_400_000 * 365) return `${Math.floor(diff / (86_400_000 * 30))}${t('unitMonths')}`
          return `${Math.floor(diff / (86_400_000 * 365))}${t('unitYears')}`
        }

        const showToast = (message) => {
          if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode)
          toastNode = el('div', 'sdw-launch-toast', message)
          document.body.appendChild(toastNode)
          if (toastTimer) window.clearTimeout(toastTimer)
          toastTimer = window.setTimeout(() => {
            if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode)
            toastNode = null
          }, 1600)
        }

        // --- native menu surface ---------------------------------------------
        const closeHover = () => {
          if (hoverTimer) { window.clearTimeout(hoverTimer); hoverTimer = 0 }
          if (hoverNode && hoverNode.parentNode) hoverNode.parentNode.removeChild(hoverNode)
          hoverNode = null
        }
        const showHover = (anchor, content) => {
          closeHover()
          const card = el('div', 'sdw-launch-hover')
          card.appendChild(el('div', 'sdw-launch-hover-title', content.title))
          if (content.path) card.appendChild(el('div', 'sdw-launch-hover-path', content.path))
          if (content.time) card.appendChild(el('div', 'sdw-launch-hover-time', content.time))
          if (content.status) card.appendChild(el('div', 'sdw-launch-hover-status', content.status))
          document.body.appendChild(card)
          hoverNode = card
          const rect = anchor.getBoundingClientRect()
          const size = card.getBoundingClientRect()
          let left = rect.left + 24
          let top = rect.bottom + 6
          if (left + size.width > window.innerWidth - 8) left = window.innerWidth - 8 - size.width
          if (left < 8) left = 8
          if (top + size.height > window.innerHeight - 8) top = rect.top - size.height - 6
          card.style.left = Math.round(left) + 'px'
          card.style.top = Math.round(top) + 'px'
        }
        const bindHover = (row, build) => {
          row.addEventListener('pointerenter', () => {
            if (hoverTimer) window.clearTimeout(hoverTimer)
            hoverTimer = window.setTimeout(() => {
              hoverTimer = 0
              if (disposed || !row.isConnected || menuNode) return
              const content = build()
              if (content) showHover(row, content)
            }, 800)
          })
          row.addEventListener('pointerleave', closeHover)
        }
        const closeMenu = () => {
          if (menuDispose) { try { menuDispose() } catch {} ; menuDispose = null }
          if (menuNode && menuNode.parentNode) menuNode.parentNode.removeChild(menuNode)
          menuNode = null
        }
        const openMenu = (anchor, items) => {
          closeHover()
          closeMenu()
          const menu = el('div', 'sdw-launch-menu')
          menu.setAttribute('role', 'menu')
          for (const item of items) {
            const button = el('button', 'sdw-launch-menu-item', item.label)
            button.type = 'button'
            button.setAttribute('role', 'menuitem')
            button.addEventListener('click', (event) => {
              event.stopPropagation()
              closeMenu()
              item.run()
            })
            menu.appendChild(button)
          }
          document.body.appendChild(menu)
          menuNode = menu
          const rect = anchor.getBoundingClientRect()
          const size = menu.getBoundingClientRect()
          const gap = 4
          let left = rect.right - size.width
          let top = rect.bottom + gap
          if (left < 8) left = 8
          if (left + size.width > window.innerWidth - 8) left = window.innerWidth - 8 - size.width
          if (top + size.height > window.innerHeight - 8) top = rect.top - size.height - gap
          menu.style.left = Math.round(left) + 'px'
          menu.style.top = Math.round(top) + 'px'
          const onPointer = (event) => { if (menuNode && !menuNode.contains(event.target)) closeMenu() }
          const onKey = (event) => { if (event.key === 'Escape') closeMenu() }
          const onScroll = () => closeMenu()
          window.setTimeout(() => {
            if (!menuNode) return
            document.addEventListener('pointerdown', onPointer, true)
            document.addEventListener('keydown', onKey, true)
            window.addEventListener('scroll', onScroll, true)
          }, 0)
          menuDispose = () => {
            document.removeEventListener('pointerdown', onPointer, true)
            document.removeEventListener('keydown', onKey, true)
            window.removeEventListener('scroll', onScroll, true)
          }
        }

        // --- status visuals (StateDot / spinner geometry) ---------------------
        const statusDot = (stateName) => {
          const node = el('span', dots && dots.dot ? dots.dot : 'sdw-fb-dot')
          node.setAttribute('data-state', stateName)
          node.setAttribute('aria-hidden', 'true')
          node.style.width = '10px'
          node.style.height = '10px'
          return node
        }
        const statusSpinner = () => {
          const node = document.createElementNS(svgNS, 'svg')
          if (dots && dots.spinner) node.setAttribute('class', dots.spinner)
          else node.setAttribute('class', 'sdw-fb-spinner')
          node.setAttribute('width', '14')
          node.setAttribute('height', '14')
          node.setAttribute('viewBox', '0 0 24 24')
          node.setAttribute('aria-hidden', 'true')
          const group = document.createElementNS(svgNS, 'g')
          if (dots && dots.spinnerMotion) group.setAttribute('class', dots.spinnerMotion)
          else group.setAttribute('class', 'sdw-fb-spinnerMotion')
          for (const shape of ['spinnerTrack', 'spinnerArc']) {
            const circle = document.createElementNS(svgNS, 'circle')
            if (dots && dots[shape]) circle.setAttribute('class', dots[shape])
            else circle.setAttribute('class', 'sdw-fb-' + shape)
            circle.setAttribute('cx', '12')
            circle.setAttribute('cy', '12')
            circle.setAttribute('r', '9.5')
            group.appendChild(circle)
          }
          node.appendChild(group)
          return node
        }

        const iconButton = (className, iconName, label, onClick) => {
          const button = el('button', className)
          button.type = 'button'
          button.title = label
          button.setAttribute('aria-label', label)
          button.appendChild(icon(iconName))
          button.addEventListener('click', (event) => {
            event.stopPropagation()
            onClick(event)
          })
          return button
        }

        // --- row builders -----------------------------------------------------
        const renderSession = (group, session) => {
          const C = classes
          const pending = Number(session.pendingApprovals || 0) > 0
          const running = !pending && session.status === 'running'
          const selected = activeSessionId !== null && String(session.sessionId || '') === activeSessionId
          const row = el('div', selected ? `${C.sessionRow} ${C.selected}` : C.sessionRow)
          row.setAttribute('role', 'treeitem')
          row.setAttribute('aria-selected', selected ? 'true' : 'false')
          row.dataset.shadowRow = 'session:' + String(session.sessionId || '')
          const slot = el('span', C.slot)
          if (pending) slot.appendChild(statusDot('warning'))
          else if (running) slot.appendChild(statusSpinner())
          const title = el('span', C.title, String(session.title || session.sessionId || ''))
          const time = el('span', C.time, pending ? t('pendingApproval') : nativeTimeLabel(session.updatedAt))
          const actions = el('span', C.rowActions)
          actions.appendChild(iconButton(C.iconButton, 'ellipsis', t('sessionActions'), () => {
            openMenu(actions.lastChild, [
              { label: t('menuOpenSession'), run: () => openRoute({ group, sessionId: session.sessionId }) },
              {
                label: t('menuCopyId'),
                run: () => {
                  void copyText(String(session.sessionId || '')).then((ok) => showToast(ok ? t('copied') : String(session.sessionId || '')))
                },
              },
            ])
          }))
          row.append(slot, title, time, actions)
          row.addEventListener('click', () => openRoute({ group, sessionId: session.sessionId }))
          row.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            openRoute({ group, sessionId: session.sessionId })
          })
          row.tabIndex = 0
          bindHover(row, () => {
            const plain = nativeTimeLabel(session.updatedAt)
            return {
              title: String(session.title || session.sessionId || ''),
              time: plain === t('timeNow') ? plain : `${plain}${t('agoSuffix')}`,
              status: pending ? t('pendingApproval') : running ? t('rowRunning') : t('statusIdle'),
            }
          })
          return row
        }

        const renderGroup = (group) => {
          const C = classes
          const B = browser
          const key = groupKey(group)
          const collapsed = collapsedGroups.has(key)
          const section = el('div', B.groupSection)
          section.dataset.shadowGroup = key
          const row = el('div', C.projectRow)
          row.setAttribute('role', 'treeitem')
          row.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
          row.dataset.shadowRow = 'workspace:' + key
          row.tabIndex = 0
          const folder = el('span', `${C.slot} ${C.folder}`)
          folder.appendChild(icon(collapsed ? 'folderClose' : 'folderOpen'))
          const chevron = el('span', `${C.slot} ${C.chevron}`)
          chevron.appendChild(icon('triangle', 14, collapsed ? C.arrow : `${C.arrow} ${C.arrowOpen}`))
          const text = el('span', C.projectText)
          const display = (state && state.display) || {}
          const allGroups = Array.isArray(display.groups) ? display.groups : []
          const multiDevice = new Set(allGroups.map((item) => item.deviceId)).size > 1
          const groupTitle = workspaceAlias(group) || String(group.workspaceTitle || group.workspaceId || '')
          text.appendChild(el('span', C.title, multiDevice && group.deviceName ? `${groupTitle} · ${group.deviceName}` : groupTitle))
          const actions = el('span', C.rowActions)
          actions.appendChild(iconButton(C.iconButton, 'ellipsis', t('workspaceActions'), () => {
            openMenu(actions.lastChild, [
              { label: t('settings'), run: () => openRoute(null) },
              { label: t('refresh'), run: () => { void load(true) } },
            ])
          }))
          actions.appendChild(iconButton(C.iconButton, 'newChat', t('newSession'), () => openRoute({ group, create: true })))
          row.append(folder, chevron, text, actions)
          const toggle = () => {
            if (collapsedGroups.has(key)) collapsedGroups.delete(key)
            else collapsedGroups.add(key)
            try { window.localStorage.setItem(STORE_KEY, JSON.stringify([...collapsedGroups])) } catch {}
            render()
          }
          row.addEventListener('click', toggle)
          row.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggle()
          })
          bindHover(row, () => {
            const sessions = Array.isArray(group.sessions) ? group.sessions : []
            const display = (state && state.display) || {}
            const online = display.enabled !== false && !(display.state && display.state.online === false)
            return {
              title: groupTitle,
              path: `${group.deviceName || group.deviceId || '—'} · ${t('peerWorkspaces')}`,
              time: `${sessions.length} ${t('sessionCountUnit')}`,
              status: display.enabled === false ? t('displayOff') : online ? t('online') : t('offline'),
            }
          })
          section.appendChild(row)
          const sessions = collapsed ? [] : (Array.isArray(group.sessions) ? group.sessions : [])
          const expanded = expandedGroups.has(key)
          const visible = expanded ? sessions : sessions.slice(0, SESSION_PREVIEW)
          for (const session of visible) section.appendChild(renderSession(group, session))
          if (!collapsed && sessions.length > SESSION_PREVIEW) {
            const overflow = el('button', B.sessionOverflowButton)
            overflow.type = 'button'
            overflow.textContent = expanded
              ? t('collapse')
              : `${t('expandRest')} ${sessions.length - SESSION_PREVIEW} ${t('sessionCountUnit')}`
            // Match the native overflow row color exactly (label-tertiary); the
            // launcher's pure-white text rule must not paint this one.
            overflow.style.color = nativeComputedColor('[class*="_sessionOverflowButton"]', 'var(--dsw-alias-label-tertiary,#8b9096)')
            overflow.addEventListener('click', () => {
              if (expanded) expandedGroups.delete(key)
              else expandedGroups.add(key)
              render()
            })
            section.appendChild(overflow)
          }
          return section
        }

        // --- native list parking ---------------------------------------------
        // `sidebar.workspaces` is a kind=single slot already owned by the native
        // workspace list, so a second slot entry is abdicated. Park the launcher
        // inside the list's scroll container instead: it then scrolls with the
        // native sections and never covers them, including on short windows.
        let flowTarget = null
        let flowObserver = null
        // Native rows are only measured by the fixed-overlay fallback; the flow
        // mode parks a flex child in the sidebar region area instead.
        const nativeWorkspaceRows = () => Array.from(document.querySelectorAll('[data-row-key^="session:"],[data-row-key^="workspace:"]'))
          .filter((node) => !host.contains(node))
          .filter((node) => {
            const rect = node.getBoundingClientRect()
            return rect.width > 120 && rect.width < 480 && rect.height > 0
          })
        const findFlowTarget = () => {
          // Attach directly to the tail of the native session list: the shadow
          // block is the last child of the sidebar list's scroll container, so
          // its top starts right after the last native session (not bottom-
          // aligned to the sidebar). Injecting as a slot entry is impossible:
          // sidebar.workspaces is kind=single and already owned by the native
          // list, so DOM parking is the only way in.
          const aside = document.querySelector('aside')
          const rows = nativeWorkspaceRows()
          if (rows.length === 0) return null
          let best = null
          let node = rows[0].parentElement
          while (node && node !== document.documentElement) {
            if (node !== host && !host.contains(node) && (!aside || aside.contains(node))) {
              const style = window.getComputedStyle(node)
              if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && rows.every((row) => node.contains(row))) {
                best = node
              }
            }
            node = node.parentElement
          }
          return best
        }
        const adoptFlow = (target) => {
          if (!target || host.contains(target)) return false
          if (mode !== 'flow') {
            mode = 'flow'
            host.className = 'sdw-launch-host sdw-launch-flow'
            host.style.cssText = ''
            clientDebug('launcher', `park in native list: ${String(target.className || '').slice(0, 60)}`)
          }
          if (host.parentElement !== target) target.appendChild(host)
          if (flowTarget !== target) {
            flowTarget = target
            clientDebug('launcher', `retarget: ${String(target.className || '').slice(0, 60)}`)
            if (flowObserver) { try { flowObserver.disconnect() } catch {} }
            if (typeof MutationObserver !== 'undefined') {
              flowObserver = new MutationObserver(() => {
                if (disposed || mode !== 'flow') return
                if (!flowTarget || flowTarget.isConnected === false) {
                  const target = findFlowTarget()
                  if (target) adoptFlow(target)
                  return
                }
                // Native sections can load asynchronously (remote/account
                // workspaces); keep the shadow section as the last child so it
                // never lands between native groups.
                if (host.parentElement !== flowTarget || flowTarget.lastElementChild !== host) flowTarget.appendChild(host)
              })
              try { flowObserver.observe(target, { childList: true }) } catch {}
            }
          }
          return true
        }
        try { adoptFlow(findFlowTarget()) } catch {}

        // --- layout -----------------------------------------------------------
        const place = () => {
          if (disposed) return
          if (mode === 'flow') {
            // Re-evaluate on every pass: peer/account sections load asynchronously
            // into sibling scroll containers, so the parking target can move.
            const target = findFlowTarget()
            if (!target) {
              if (!flowTarget || flowTarget.isConnected === false) clientDebug('launcher', 'flow target missing; keeping current parent', 'warn')
              return
            }
            if (target !== flowTarget || flowTarget.isConnected === false || host.parentElement !== target) adoptFlow(target)
            else if (target.lastElementChild !== host) target.appendChild(host)
            return
          }
          if (mode !== 'fixed') return
          try {
            const nativeRows = nativeWorkspaceRows()
            let rowRect = null
            let contentBottom = 0
            for (const node of nativeRows) {
              const rect = node.getBoundingClientRect()
              if (!rect.width || rect.height <= 0) continue
              if (rect.left > 480 || rect.top < 0) continue
              if (!rowRect) rowRect = rect
              if (rect.bottom > contentBottom) contentBottom = rect.bottom
            }
            if (adoptFlow(findFlowTarget())) return
            if (rowRect && rowRect.width > 120 && rowRect.width < 480) {
              host.style.left = Math.round(rowRect.left) + 'px'
              // Match the native row's content width exactly: the scroller keeps a
              // stable gutter, so the gutter width is added outside the rows.
              const scroll = host.firstElementChild
              let gutter = 0
              if (scroll && scroll.offsetWidth > 0) gutter = Math.max(0, scroll.offsetWidth - scroll.clientWidth)
              const nextWidth = Math.round(rowRect.width + gutter) + 'px'
              if (host.style.width !== nextWidth) {
                host.style.width = nextWidth
                schedulePlace()
              }
            } else {
              host.style.left = '8px'
              host.style.width = '264px'
            }
            const label = document.querySelector('[class*="_sectionLabel"]')
            if (label) {
              const computed = window.getComputedStyle(label)
              if (computed.fontFamily) host.style.fontFamily = computed.fontFamily
              if (computed.fontSize) host.style.fontSize = computed.fontSize
            }
            const gap = 56
            const available = contentBottom > 40 ? (window.innerHeight - gap - contentBottom - 12) : 0
            if (available >= 190) {
              host.style.top = Math.round(contentBottom + 10) + 'px'
              host.style.bottom = 'auto'
              host.style.maxHeight = Math.round(Math.min(available, 520)) + 'px'
            } else {
              // Pin just above the native footer area (its height differs between
              // window sizes / platforms); 56px is only the last-resort fallback.
              let footerGap = gap
              const foot = document.querySelector('[class*="_footArea"]')
              if (foot) {
                const rect = foot.getBoundingClientRect()
                if (rect.height > 0 && rect.top > 160 && rect.top < window.innerHeight) {
                  footerGap = Math.round(window.innerHeight - rect.top + 6)
                }
              }
              host.style.top = 'auto'
              host.style.bottom = footerGap + 'px'
              host.style.maxHeight = Math.round(Math.min(420, Math.max(190, window.innerHeight - footerGap - 140))) + 'px'
            }
          } catch {}
        }
        const schedulePlace = () => {
          if (disposed || frame) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            place()
          })
        }

        // Read a native element's computed color so replica chrome can match the
        // live theme instead of guessing tokens.
        const nativeComputedColor = (selector, fallback) => {
          try {
            const node = document.querySelector(selector)
            if (node) {
              const color = window.getComputedStyle(node).color
              if (color) return color
            }
          } catch {}
          return fallback
        }

        // --- render -----------------------------------------------------------
        const render = () => {
          if (disposed) return
          // Device-sync "影子工作区" gate (settings.shadowWorkspace.enabled):
          // hide the whole launcher while the switch is off. `null` means the
          // backend did not report the setting yet, so the legacy always-visible
          // behaviour is kept.
          if (gate && gate.enabled === false) {
            host.textContent = ''
            host.style.display = 'none'
            return
          }
          if (host.style.display === 'none') host.style.display = ''
          closeMenu()
          closeHover()
          ensureClasses()
          host.textContent = ''
          const display = (state && state.display) || {}
          const groups = Array.isArray(display.groups) ? display.groups : []
          const online = display.enabled !== false && !(display.state && display.state.online === false)
          const B = browser
          const scroll = el('div', 'sdw-launch-scroll')
          scroll.dataset.role = 'shadow-workspace-list'
          const header = el('div', B.sectionHeader)
          const headerLabel = el('span', B.sectionLabel, t('title'))
          // Native section headers are gray, not white: copy the live color.
          headerLabel.style.color = nativeComputedColor('[class*="_sectionLabel"]', 'var(--dsw-alias-label-tertiary,#8b9096)')
          header.appendChild(headerLabel)
          const headActions = el('div', B.headerActions)
          headActions.style.marginLeft = 'auto'
          if (!online) {
            const badge = el('span', 'sdw-launch-status')
            badge.title = t('offline')
            headActions.appendChild(badge)
          }
          headActions.appendChild(iconButton(B.iconButton, 'settings', t('settings'), () => openRoute(null)))
          headActions.appendChild(iconButton(B.iconButton, 'refresh', t('refresh'), () => { void load(true) }))
          header.appendChild(headActions)
          scroll.appendChild(header)
          if (groups.length === 0) {
            scroll.appendChild(el('div', B.empty, display.enabled === false ? t('displayOff') : t('noGroups')))
          }
          for (const group of groups) scroll.appendChild(renderGroup(group))
          host.appendChild(scroll)
          place()
        }

        const applyState = (value) => {
          state = value || null
          const display = (value && value.display) || {}
          const groups = Array.isArray(display.groups) ? display.groups : []
          const online = display.enabled !== false && !(display.state && display.state.online === false)
          const next = JSON.stringify({
            gate: gate ? (gate.enabled === true ? 1 : gate.enabled === false ? 0 : -1) : -1,
            enabled: display.enabled !== false,
            online,
            groups: groups.map((group) => [
              group.deviceId,
              group.workspaceId,
              group.workspaceTitle,
              (Array.isArray(group.sessions) ? group.sessions : []).map((session) => [
                session.sessionId,
                session.title,
                session.status,
                session.updatedAt,
                session.pendingApprovals,
              ]),
            ]),
          })
          if (next !== signature) {
            signature = next
            render()
          } else {
            schedulePlace()
          }
        }

        // Best-effort gate: read the device-sync panel's
        // `settings.shadowWorkspace.enabled` as well, so the sidebar entry hides
        // even before the sync page has been opened. Any failure keeps the gate
        // unknown (legacy: launcher stays visible).
        const readGate = async () => {
          if (!gate) return
          try {
            const response = await fetch('/plugins/dsh-plugin-dsh-sync/panel', {
              method: 'GET',
              credentials: 'same-origin',
              headers: { 'x-dsh-sync': 'local' },
            })
            const value = await response.json().catch(() => null)
            const shadow = value && value.state && value.state.settings && value.state.settings.shadowWorkspace
            if (shadow && typeof shadow.enabled === 'boolean') gate.enabled = shadow.enabled
          } catch {}
        }
        const load = async (silent) => {
          try {
            await readGate()
            const value = await panelApi('')
            applyState(value.state)
          } catch (error) {
            clientDebug('panel', `launcher refresh failed: ${errorLine(error)}`, silent ? 'debug' : 'warn')
            if (!signature) applyState({ display: { groups: [] } })
          }
        }

        void load(false)
        for (const delay of [120, 400, 900, 1800, 3200]) {
          window.setTimeout(() => { if (!disposed) place() }, delay)
        }
        timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void load(true)
        }, 5000)
        const onViewport = () => {
          closeHover()
          schedulePlace()
        }
        const onAliases = () => { render() }
        // The device-sync panel flips the shared gate; re-render immediately so
        // the launcher disappears/appears without waiting for the next poll.
        const onGate = () => { render() }
        window.addEventListener('resize', onViewport)
        window.addEventListener('shadow:aliases', onAliases)
        window.addEventListener('shadow:gate', onGate)
        document.addEventListener('scroll', onViewport, true)
        const stop = () => {
          if (disposed) return
          disposed = true
          if (timer) window.clearInterval(timer)
          if (frame) window.cancelAnimationFrame(frame)
          if (toastTimer) window.clearTimeout(toastTimer)
          if (flowObserver) { try { flowObserver.disconnect() } catch {} }
          closeHover()
          closeMenu()
          window.removeEventListener('resize', onViewport)
          window.removeEventListener('shadow:aliases', onAliases)
          window.removeEventListener('shadow:gate', onGate)
          document.removeEventListener('scroll', onViewport, true)
          if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode)
          try { host.remove() } catch {}
        }
        ctx.effect(() => stop, 'shadow-workspace: launcher')
        return stop
      }
      // The launcher parks itself inside the native workspace list scroll
      // container (the shell exposes no list-kind slot for that column; its
      // `sidebar.workspaces` slot is kind=single and already owned by the native
      // workspace list), so it scrolls with the native sections instead of
      // covering them on small windows. A fixed overlay remains as fallback.
      let launcherStop = null
      const mount = () => {
        refresh()
        if (!launcherStop) launcherStop = mountLauncher()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh()
        }, 5000)
        ctx.effect(() => () => {
          clearInterval(timer)
          disposeAll()
        }, 'shadow-workspace: sidebar entries')
      }
      if (typeof ctx.slots.inject === 'function') {
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          ready = true
          clientDebug('slot', 'main + sidebar.panellist ready; injecting entries')
          mount()
          return () => {
            ready = false
            clientDebug('slot', 'slot injection disposed; removing entries')
            disposeAll()
          }
        })), 'shadow-workspace: slot injection')
      } else {
        ready = true
        mount()
      }
    }

    return {
      name: 'dsh-plugin-shadow-workspace',
      inject,
      apply,
      // Pure transcript/model helpers exposed for the unit tests. The Host
      // loader only reads `name`/`inject`/`apply`; DSH never calls this object.
      __testing: {
        parseArgs,
        toolKind,
        toolSummary,
        toolResultOf,
        extractEdit,
        extractWrite,
        lineDiff,
        firstLine,
        tailLines,
        formatDuration,
        modelKey,
        findCatalogModel,
        modelLabel,
        normalizeQuestion,
        normalizeQuestionRequest,
        planReviewOf,
        planReviewSummary,
        blankQuestionDrafts,
        questionAnswerErrors,
        buildQuestionAnswers,
        approvePlanAnswers,
        questionAnswerLines,
        formatFileSize,
        bytesToBase64,
        uploadChunksOf,
        sha256HexOf,
        pushLocalFile,
        PushFileCard,
        // Native-like chat model (0.10.0): transcript grouping, markdown
        // blocks, tool facts, scroll follow and relative time.
        buildTranscript,
        attachLive,
        processStats,
        toolRowModel,
        toolRowRunning,
        searchStats,
        exitCodeOf,
        scrollFollow,
        // Composer controls (0.10.25): permission labels, attachment kinds, the
        // answered-question row model and the voice WAV encoder.
        permissionLabelOf,
        attachmentKindOf,
        questionRowModel,
        encodeWav16k,
        clockText,
        relativeTime,
        markdownBlocks,
        // Localized dictionaries, so the headless harness renders the real copy.
        strings: { zh, en },
        // Test/verification hook only: the headless UI harness renders the real
        // chat page against mocked shadow routes (DSH never calls this object).
        ChatPage,
        SettingsPage,
        DisplayRows,
        aliasKeyOf,
        workspaceAlias,
        setWorkspaceAlias,
      },
    }
    }

    // One merged shadow client instance per plugin load; `apply()` is called by
    // the dsh-sync client below so both UIs register from a single loader call.
    const shadowClient = createShadowClient(require, shadowGate)

    const inject = ['slots', 'layout', 'locale']
    function apply(ctx) {
      ensureStyle()
      const registerAll = () => {
        const stopPanel = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ ctx }) }, Panel)
        let stopIcon
        try {
          stopIcon = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 43, label: () => STR.title }, SyncIcon)
        } catch (error) {
          stopPanel()
          throw error
        }
        return () => { try { stopIcon() } catch {} ; try { stopPanel() } catch {} }
      }
      ctx.effect(() => {
        if (typeof ctx.slots.inject === 'function') return ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => registerAll()))
        return registerAll()
      }, 'dsh-sync: sidebar entry + main panel')
      // After the device-sync panel/icon, attach the merged Shadow Workspace
      // client so its own sidebar entries register too (same ctx, same bundle).
      try {
        shadowClient.apply(ctx)
      } catch (error) {
        console.warn('[dsh-sync] shadow workspace UI failed to attach:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-plugin-dsh-sync'
    exports.__shadowTesting = shadowClient.__testing
    // Pure device-sync helpers exposed for the unit tests (the Host loader only
    // reads name/inject/apply; DSH never calls this object).
    exports.__syncTesting = {
      deriveRole,
      readSettings,
      normalizeSets,
      normalizeCatalog,
      pendingSets,
      setsPayload,
      pageOf,
      bytesOfFiles,
      clampRecycleMax,
      normalizeConflict,
      conflictActiveDays,
      conflictProducedDays,
      conflictEligible,
      isUnknownAction,
      sasText,
      peerRoleOf,
      shadowGate,
      PanelBody,
    }
    return module.exports
  },
})


































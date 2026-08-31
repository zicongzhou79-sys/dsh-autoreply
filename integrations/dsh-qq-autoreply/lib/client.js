/**
 * dsh-qq-autoreply client half: a compact QQ AutoReply status bar for the
 * web GUI. The control entry is rendered beside the DSH sidebar settings
 * action, and opens a panel with service, QQ login, DSH model/agent/workspace
 * selection, sessions and logs.
 *
 * Host communication is plain fetch to relative /dsh-qq/* paths for AutoReply
 * control. DSH-owned model, agent preset and workspace data use the connection
 * API directly.
 *
 * Loaded by the DSH ModuleLoader as a plain React plugin (see
 * ../package.json exports "./client" + the dsh.client declaration).
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-autoreply',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
      const Primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    // ---- tiny JSON helpers (relative paths are proxied by DSH frontend) ----
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    const AUTOREPLY_BASE = '/dsh-qq';

    // AutoReply 后端不可达时的展示状态：保证状态条/面板始终可见，而不是整个消失
    const OFF_STATUS = {
      onebot_connected: false, onebot_login: false, llm_configured: false,
      dsh_online: false, master_switch: false,
      stats: { in: 0, out: 0, answered: 0, skipped: 0 },
    };

    // ---- fetch through plugin's /dsh-qq/execute (bypasses nothing, keeps single entry) ----
    const arGet = (path) => fetch(AUTOREPLY_BASE + path, { cache: 'no-store' }).then((r) => r.json());
    const arExec = async (tool, args) => {
      const d = await jsonPost(AUTOREPLY_BASE + '/execute', { tool, args: args || {} });
      if (!d.ok) throw new Error(d.error || '工具失败');
      return d.result;
    };

    // ---- CSS (scoped under .qqa- panel) ----
    const CSS = `
.qqa-bar { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%;
  max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 4px 10px;
  font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.04));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius: 8px;
  cursor: default; user-select: none; position: relative; overflow: hidden;
  transition: opacity .3s ease; }
.qqa-bar .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.qqa-bar .dot.ok { background: var(--dsw-alias-state-success, #3fb950); }
.qqa-bar .dot.bad { background: var(--dsw-alias-state-error-primary, #f85149); }
.qqa-bar .dot.warn { background: var(--dsw-alias-state-warn-primary, #d29922); }
.qqa-bar .lbl { white-space: nowrap; }
.qqa-bar .spacer { flex: 1; }
.qqa-bar .stats { display: flex; gap: 8px; white-space: nowrap; }
.qqa-bar .btn { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));
  color: var(--dsw-alias-label-secondary, #8a8f98); border-radius: 6px; padding: 2px 8px;
  font-size: 11px; cursor: pointer; white-space: nowrap; }
.qqa-bar .btn:hover { color: var(--dsw-alias-label-primary, #e6edf3); border-color: var(--dsw-alias-brand-primary, #58a6ff); }
.qqa-panel { box-sizing: border-box; position: fixed; left: 72px; top: 58px; bottom: auto; width: min(560px, calc(100vw - 96px));
  max-height: calc(100vh - 74px); overflow-y: auto; z-index: 999; font-size: 13px;
  color: var(--dsw-alias-label-primary, #e6edf3);
  background: var(--dsw-alias-bg-overlay, rgba(17,20,25,.98));
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.42); padding: 20px; }
  .qqa-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: -4px 0 16px; }
  .qqa-panel-title { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6edf3); }
  .qqa-panel-actions { display: flex; align-items: center; gap: 4px; }
  .qqa-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    padding: 0; border: 0; border-radius: 50%; color: var(--dsw-alias-label-secondary, #8a8f98);
    background: transparent; cursor: pointer; }
  .qqa-icon-button:hover { color: var(--dsw-alias-label-primary, #e6edf3); background: var(--dsw-alias-interactive-bg-hover); }
  .qqa-section { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); padding-top: 14px; margin-top: 14px; }
  .qqa-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .qqa-kv { min-width: 0; padding: 8px 10px; border-radius: 8px; }
  .qqa-row { min-height: 28px; align-items: center; padding: 5px 0; }
  .qqa-login-frame { width: 100%; height: 320px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius: 10px; background: #fff; margin-top: 8px; }
  .qqa-trigger { box-sizing: border-box; cursor: pointer; width: calc(100% + 4px); height: 42px;
    color: var(--dsw-alias-label-primary); background: transparent; border: none; border-radius: 12px;
    align-items: center; gap: 8px; margin: 4px -2px; padding: 0 10px 0 8px; font-family: inherit;
    font-size: 14px; line-height: 22px; display: flex; overflow: hidden; }
  .qqa-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .qqa-trigger.rail { border-radius: 50%; justify-content: center; gap: 0; width: 36px; height: 36px; margin: 8px 0 10px; padding: 0; }
  .qqa-trigger-label { white-space: nowrap; overflow: hidden; }
.qqa-panel h4 { margin: 10px 0 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98);
  text-transform: uppercase; letter-spacing: .4px; }
.qqa-panel h4:first-child { margin-top: 0; }
.qqa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.qqa-kv { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.04)); border-radius: 6px; }
.qqa-kv b { font-weight: 600; }
.qqa-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12)); }
.qqa-row .reason { color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.qqa-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.qqa-toggle input { display: none; }
.qqa-toggle .tknob { width: 26px; height: 14px; border-radius: 10px; position: relative;
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.2)); border: 1px solid var(--dsw-alias-border-l1); transition: .2s; }
.qqa-toggle .tknob::after { content: ''; position: absolute; width: 10px; height: 10px; border-radius: 50%;
  left: 2px; top: 1px; background: var(--dsw-alias-label-secondary, #8a8f98); transition: .2s; }
.qqa-toggle input:checked + .tknob { background: rgba(63,185,80,.25); }
.qqa-toggle input:checked + .tknob::after { transform: translateX(12px); background: #3fb950; }
.qqa-err { color: var(--dsw-alias-state-error-primary, #f85149); }
.qqa-service { display: flex; flex-direction: column; gap: 6px; }
.qqa-btn-primary { border: 1px solid rgba(63,185,80,.45); background: rgba(63,185,80,.14);
  color: #3fb950; border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 600;
  cursor: pointer; width: 100%; }
.qqa-btn-primary:hover:not(:disabled) { background: rgba(63,185,80,.22); }
.qqa-btn-primary.on { border-color: rgba(248,81,73,.5); background: rgba(248,81,73,.14);
  color: #f85149; }
.qqa-btn-primary.on:hover:not(:disabled) { background: rgba(248,81,73,.22); }
.qqa-btn-primary:disabled { opacity: .55; cursor: default; }
.qqa-btn-compact { width: auto; padding: 6px 16px; }
.qqa-chat { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto; margin-top:8px; padding:8px; border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius:8px; }
.qqa-chat-msg { display:flex; gap:8px; align-items:baseline; padding:5px 7px; background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)); border-radius:5px; }
.qqa-chat-msg b { flex:none; font-size:11px; }
.qqa-chat-msg span { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.qqa-chat-error { padding:6px 7px; color:var(--dsw-alias-state-error-primary,#f85149); background:rgba(248,81,73,.1); border-radius:5px; }
.qqa-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98);
  word-break: break-word; line-height: 1.45; }
  .qqa-section { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15)); padding-top: 8px; margin-top: 8px; }
  .qqa-field { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
  .qqa-field label { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }
  .qqa-select { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
  .qqa-login-frame { width: 100%; height: 300px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); border-radius: 8px; background: #fff; margin-top: 6px; }
    border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
    color: var(--dsw-alias-label-primary, #e6edf3); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.12)); font-size: 12px; }
  .qqa-session-list { max-height: 150px; overflow-y: auto; }
  .qqa-error { color: var(--dsw-alias-state-error-primary, #f85149); margin: 6px 0; }
  .qqa-topbar { display: flex; align-items: center; gap: 10px; padding: 2px 0 12px; margin-bottom: 14px; border-bottom: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15)); position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-overlay,rgba(17,20,25,.98)); }
  .qqa-topbar-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 400; color: var(--dsw-alias-label-primary,#e6edf3); white-space: nowrap; }
  .qqa-brand-icon { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; background: var(--dsw-alias-label-primary,#e6edf3); color: #111; font-size: 10px; font-weight: 700; }
  .qqa-topbar-status { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary,#8a8f98); font-size: 11px; white-space: nowrap; }
  .qqa-topbar .spacer { flex: 1; }
  .qqa-login-actions { display: flex; gap: 6px; margin-top: 6px; }
  .qqa-binding-top { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .qqa-rule-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .qqa-login-actions .qqa-btn { flex: 1; min-width: 0; padding: 6px 4px; border: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary,#e6edf3); font-size: 11px; cursor: pointer; white-space: nowrap; }
  .qqa-login-actions .qqa-btn:hover { border-color: var(--dsw-alias-brand-primary,#58a6ff); }
  .qqa-bind-list { display: grid; gap: 6px; margin-top: 8px; }
  .qqa-bind-row { display: grid; grid-template-columns: minmax(0,1fr) 86px 66px; align-items: center; gap: 6px; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04)); }
  .qqa-bind-name { min-width: 0; }
  .qqa-bind-name strong { display: block; font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qqa-bind-name small { display: block; color: var(--dsw-alias-label-secondary,#8a8f98); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qqa-bind-tag { color: #a9d8ff; background: #183049; border-radius: 4px; padding: 3px 5px; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
  .qqa-bind-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
  .qqa-mini { padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary,#8a8f98); font-size: 10px; cursor: pointer; white-space: nowrap; }
  .qqa-mini:hover { color: var(--dsw-alias-label-primary,#e6edf3); border-color: var(--dsw-alias-brand-primary,#58a6ff); }
  .qqa-chat-layout { display: grid; grid-template-columns: 120px minmax(0,1fr); min-height: 220px; margin-top: 8px; border: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); border-radius: 8px; overflow: hidden; }
  .qqa-chat-list { border-right: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2)); background: var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03)); overflow-y: auto; }
  .qqa-chat-item { padding: 8px 9px; cursor: pointer; border-bottom: 1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12)); font-size: 11px; }
  .qqa-chat-item:hover, .qqa-chat-item.active { background: rgba(88,166,255,.12); }
  .qqa-chat-item strong { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qqa-chat-item small { display: block; color: var(--dsw-alias-label-secondary,#8a8f98); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qqa-messages { display: flex; flex-direction: column; gap: 8px; padding: 10px; background: #0d1218; overflow-y: auto; max-height: 360px; }
  .qqa-msg { display: flex; gap: 6px; align-items: flex-start; }
  .qqa-msg.ai { flex-direction: row-reverse; }
  .qqa-msg .qqa-avatar { width: 22px; height: 22px; flex: none; border-radius: 5px; background: #31465e; color: #dce6f0; font-size: 9px; display: grid; place-items: center; }
  .qqa-msg.ai .qqa-avatar { background: #b9f0c9; color: #102217; }
  .qqa-bubble { max-width: 85%; padding: 6px 8px; border-radius: 4px 7px 7px 7px; background: #202a38; font-size: 11px; text-align: left; word-break: break-word; }
  .qqa-msg.ai .qqa-bubble { background: #b9f0c9; color: #102217; border-radius: 7px 4px 7px 7px; }
  .qqa-msg.error .qqa-bubble { background: #3b2026; color: #ffb8bd; border: 1px solid #f8514966; }
  .qqa-msg .qqa-meta { display: block; font-size: 9px; color: var(--dsw-alias-label-secondary,#8a8f98); margin-bottom: 2px; }
  .qqa-chat-empty { display: grid; place-items: center; height: 100%; color: var(--dsw-alias-label-secondary,#8a8f98); font-size: 11px; }
`;

    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts * 1000);
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // ---- Status Bar (composer dock) ----
      // Sidebar control button: same geometry as the DSH settings trigger.
      function StatusBar({ wide, onTogglePanel }) {
        const Icon = Primitives.IconSettingsOutline16;
        return React.createElement('button', {
          type: 'button', className: 'qqa-trigger' + (wide ? '' : ' rail'),
          'aria-label': 'QQ 自动回复', 'aria-haspopup': 'dialog',
          onClick: onTogglePanel,
        },
          React.createElement(Icon, { size: wide ? 16 : 18 }),
          wide ? React.createElement('span', { className: 'qqa-trigger-label' }, 'QQ 自动回复') : null,
        );
      }


    function LegacyStatusBar({ status, onTogglePanel }) {
      if (!status) return null;
      const lamp = (ok, cls) =>
        React.createElement('span', { className: 'dot ' + (ok ? 'ok' : 'bad'), style: { background: undefined } },
          ok ? '' : '');
      return React.createElement('div', { className: 'qqa-bar' },
        React.createElement('span', { className: 'dot ' + (status.onebot_connected ? 'ok' : 'bad') }),
        React.createElement('span', { className: 'lbl' }, 'QQ' + (status.onebot_login ? '✓' : '✗')),
        React.createElement('span', { className: 'dot ' + (status.llm_configured ? 'ok' : 'bad') }),
        React.createElement('span', { className: 'lbl' }, 'LLM' + (status.llm_configured ? '✓' : '✗')),
        React.createElement('span', { className: 'dot ' + (status.dsh_online ? 'ok' : 'bad') }),
        React.createElement('span', { className: 'lbl' }, 'DSH' + (status.dsh_online ? '✓' : '✗')),
        React.createElement('span', { className: 'spacer' }),
        React.createElement('span', { className: 'stats' },
          React.createElement('span', null, '收' + (status.stats ? status.stats.in : 0)),
          React.createElement('span', null, '回' + (status.stats ? status.stats.answered : 0)),
          React.createElement('span', null, '拦' + (status.stats ? status.stats.skipped : 0)),
        ),
        React.createElement('button', { className: 'btn', onClick: (e) => { e.stopPropagation(); onTogglePanel(); } },
          '详情'),
      );
    }

    // ---- Detail Panel (overlay) ----
    function renderLogs(logs) {
      const items = (logs && logs.length ? logs : []).map(function (l) {
        return React.createElement('div', { className: 'qqa-row', key: l.id },
          React.createElement('span', null, fmtTime(l.ts)),
          React.createElement('span', { className: 'reason' },
            (l.decision || '') + (l.reason ? '·' + l.reason : '') + (l.llm_output ? ' | ' + String(l.llm_output).slice(0, 24) : '')),
        );
      });
      if (items.length === 0) items.push(React.createElement('div', { className: 'qqa-row' }, React.createElement('span', null, '暂无')));
      return items;
    }

    function renderSessions(sessions) {
      const items = (sessions && sessions.length ? sessions : []).slice(0, 5).map(function (s) {
        return React.createElement('div', { className: 'qqa-row', key: s.chat_key },
          React.createElement('span', null, String(s.peer_name || s.chat_key).slice(0, 14)),
          React.createElement('span', { className: 'reason' }, (s.chat_type === 'group' ? '群' : '友') + ' · ' + String(s.last_text || '…').slice(0, 10)),
        );
      });
      if (items.length === 0) items.push(React.createElement('div', { className: 'qqa-row' }, React.createElement('span', null, '暂无会话')));
      return items;
    }

function SessionBindingEditor({ sessions, agents, workspaces, models, onSave, onToggleAuto, onDeleteBinding }) {
      const [chatKey, setChatKey] = React.useState('');
      const [workspace, setWorkspace] = React.useState('');
      const [model, setModel] = React.useState('');
      const [agent, setAgent] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const list = sessions || [];
      return React.createElement('div', { className: 'qqa-section' },
        React.createElement('h4', null, '会话绑定'),
        React.createElement('div', { className: 'qqa-binding-top' },
          React.createElement('div', { className: 'qqa-field' },
            React.createElement('label', null, '工作区'),
            React.createElement('select', { className: 'qqa-select', value: workspace, onChange: (e) => setWorkspace(e.target.value) },
              React.createElement('option', { value: '' }, '使用当前工作区'),
              ...(workspaces || []).map((w) => React.createElement('option', { key: w.id, value: w.path }, w.label))),
          ),
          React.createElement('div', { className: 'qqa-field' },
            React.createElement('label', null, '绑定 DSH 会话'),
            React.createElement('select', { className: 'qqa-select', value: chatKey, onChange: (e) => setChatKey(e.target.value) },
              React.createElement('option', { value: '' }, '选择私聊或群聊对象'),
              ...list.map((s) => React.createElement('option', { key: s.chat_key, value: s.chat_key }, String(s.peer_name || s.chat_key) + ' · ' + s.chat_key))),
          ),
        ),
        React.createElement('div', { className: 'qqa-field' },
          React.createElement('label', null, '此会话的 DSH 配置'),
          React.createElement('div', { className: 'qqa-binding-top' },
            React.createElement('select', { className: 'qqa-select', value: model, onChange: (e) => setModel(e.target.value) },
              React.createElement('option', { value: '' }, '跟随全局'),
              ...(models || []).map((m) => React.createElement('option', { key: m.value, value: m.value }, m.label))),
            React.createElement('select', { className: 'qqa-select', value: agent, onChange: (e) => setAgent(e.target.value) },
              React.createElement('option', { value: '' }, '跟随全局'),
              ...(agents || []).map((a) => React.createElement('option', { key: a.id, value: a.id }, a.label))),
          ),
        ),
        React.createElement('button', { className: 'qqa-btn-primary qqa-btn-compact', disabled: !chatKey || saving,
          onClick: async () => {
            setSaving(true);
            try {
              await onSave({ chat_key: chatKey, agent_preset: agent, model_provider: model.split(':')[0] || '', model_name: model.split(':').slice(1).join(':'), workspace_dir: workspace });
              setSaving(false);
            } catch (e) { setSaving(false); alert(e.message || String(e)); }
          } }, saving ? '保存中…' : '绑定会话'),
        React.createElement('div', { className: 'qqa-field' },
          React.createElement('label', null, '已绑定会话 · 管理启用状态与删除'),
          React.createElement('div', { className: 'qqa-bind-list' },
            ...list.filter((s) => s.dsh_session_id).map((s) => React.createElement('div', { className: 'qqa-bind-row', key: s.chat_key },
              React.createElement('div', { className: 'qqa-bind-name' },
                React.createElement('strong', null, s.peer_name || s.chat_key),
                React.createElement('small', null, (s.chat_type === 'group' ? '群' : '友') + ' · ' + (s.dsh_session_id || '未绑定'))),
              React.createElement('span', { className: 'qqa-bind-tag' }, s.agent_preset || '默认'),
              React.createElement('div', { className: 'qqa-bind-actions' },
                React.createElement('label', { className: 'qqa-toggle' },
                  React.createElement('input', { type: 'checkbox', checked: !!s.auto_on, onChange: (e) => onToggleAuto && onToggleAuto(s.chat_key, e.target.checked) }),
                  React.createElement('span', { className: 'tknob' })),
                React.createElement('button', { className: 'qqa-mini', onClick: () => onDeleteBinding && onDeleteBinding(s.chat_key) }, '删除'),
              ),
            )),
          ),
        ),
      );
    }

function RulesSection() {
      const [values, setValues] = React.useState({ private_auto: true, group_mode: 'mention' });
      React.useEffect(() => {
        arExec('config_get').then((cfg) => {
          const e = (cfg && cfg.config && cfg.config.engine) || {};
          setValues({ private_auto: !!e.private_auto, group_mode: e.group_mode || 'mention' });
        }).catch(() => {});
      }, []);
      const save = (patch) => arExec('config_set', { batch: patch }).catch((e) => alert(e.message || String(e)));
      const field = (key, label, node) => React.createElement('div', { className: 'qqa-field', key }, React.createElement('label', null, label), node);
      return React.createElement('div', { className: 'qqa-section' },
        React.createElement('h4', null, '回复规则'),
        React.createElement('div', { className: 'qqa-rule-grid' },
          field('private', '私聊触发', React.createElement('select', { className: 'qqa-select', value: values.private_auto ? 'on' : 'off', onChange: (e) => { const v = e.target.value === 'on'; setValues((old) => ({ ...old, private_auto: v })); save({ 'engine.private_auto': v }); } },
            React.createElement('option', { value: 'on' }, '自动回复全部私聊'),
            React.createElement('option', { value: 'off' }, '关闭私聊自动回复'))),
          field('mode', '群聊触发', React.createElement('select', { className: 'qqa-select', value: values.group_mode, onChange: (e) => { const v = e.target.value; setValues((old) => ({ ...old, group_mode: v })); save({ 'engine.group_mode': v }); } },
            React.createElement('option', { value: 'mention' }, '被 @ 时回复'),
            React.createElement('option', { value: 'keyword' }, '关键词命中时回复'),
            React.createElement('option', { value: 'all' }, '全部消息回复'),
            React.createElement('option', { value: 'off' }, '关闭群聊自动回复'))),
        ),
      );
    }

    function ChatSection({ sessions, logs }) {
      const list = sessions || [];
      const [chatKey, setChatKey] = React.useState('');
      const [messages, setMessages] = React.useState([]);
      const [visibleCount, setVisibleCount] = React.useState(20);
      React.useEffect(() => { if (!chatKey && list[0]) setChatKey(list[0].chat_key); }, [chatKey, list]);
      React.useEffect(() => {
        setVisibleCount(20);
        if (!chatKey) return;
        arExec('messages', { chat_key: chatKey, limit: 100 }).then((d) => setMessages((d && d.messages) || [])).catch(() => setMessages([]));
      }, [chatKey]);
      const shown = messages.slice(-visibleCount);
      const failures = (logs || []).filter((l) => l.chat_key === chatKey && l.decision === 'failed');
      return React.createElement('div', { className: 'qqa-section' },
        React.createElement('h4', null, '模拟聊天'),
        React.createElement('div', { className: 'qqa-chat-layout' },
          React.createElement('div', { className: 'qqa-chat-list' },
            ...list.map((s) => React.createElement('div', { key: s.chat_key, className: 'qqa-chat-item' + (s.chat_key === chatKey ? ' active' : ''), onClick: () => setChatKey(s.chat_key) },
              React.createElement('strong', null, s.peer_name || s.chat_key),
              React.createElement('small', null, (s.chat_type === 'group' ? '群聊' : '私聊') + ' · ' + (s.last_text || '…')))),
          ),
          React.createElement('div', { className: 'qqa-messages' },
            ...(shown.length ? shown.map((m) => React.createElement('div', { key: m.id, className: 'qqa-msg' + (m.direction === 'ai' ? ' ai' : '') },
              React.createElement('span', { className: 'qqa-avatar' }, (m.nick || (m.direction === 'ai' ? 'AI' : '友')).slice(0, 1)),
              React.createElement('div', null,
                React.createElement('span', { className: 'qqa-meta' }, (m.nick || (m.direction === 'ai' ? 'AI' : '成员')) + ' · ' + fmtTime(m.ts)),
                React.createElement('div', { className: 'qqa-bubble' }, m.text || '（附件）'),
              ),
            )) : [React.createElement('div', { className: 'qqa-chat-empty', key: 'empty' }, '选择左侧会话查看消息')]),
            ...failures.slice(0, 3).map((l) => React.createElement('div', { className: 'qqa-msg error ai', key: 'failure-' + l.id },
              React.createElement('span', { className: 'qqa-avatar' }, '!'),
              React.createElement('div', null,
                React.createElement('span', { className: 'qqa-meta' }, 'AI · 失败'),
                React.createElement('div', { className: 'qqa-bubble' }, '回复失败：' + (l.reason || 'DSH Agent 暂时不可用') + '。未发送到 QQ。'),
              ),
            )),
            visibleCount < messages.length ? React.createElement('button', { className: 'qqa-mini', style: { marginTop: 4 }, onClick: () => setVisibleCount((n) => Math.min(messages.length, n + 20)) }, '显示更多（' + visibleCount + '/' + messages.length + '）') : null,
          ),
        ),
      );
    }

    function DetailPanel({ status, logs, sessions, onRefresh, onToggleMaster,
      serviceBusy, serviceNote, allServicesOn, onToggleService, onRestartService, catalog,
      onOpenLogin, onSaveSessionBinding, onToggleSessionAuto, onDeleteSessionBinding, onClose }) {
      const allOk = !!(status && status.onebot_connected && status.onebot_login && status.llm_configured && status.dsh_online);
      return React.createElement('div', { className: 'qqa-panel', role: 'dialog', 'aria-label': 'QQ 自动回复控制面板' },
        React.createElement('div', { className: 'qqa-topbar' },
          React.createElement('div', { className: 'qqa-topbar-title' },
            React.createElement('span', { className: 'qqa-brand-icon' }, 'QQ'),
            React.createElement('span', null, 'QQ 自动回复')),
          React.createElement('div', { className: 'qqa-topbar-status' },
            React.createElement('span', { className: 'dot ' + (allOk ? 'ok' : 'bad') }),
            React.createElement('span', null, allOk ? '运行中' : '异常')),
          React.createElement('div', { className: 'spacer' }),
          React.createElement('button', { type: 'button', className: 'qqa-icon-button', title: '刷新', 'aria-label': '刷新', onClick: onRefresh },
            React.createElement(Primitives.IconRefreshOutline16, { size: 16 })),
          React.createElement('button', { type: 'button', className: 'qqa-icon-button', title: '关闭', 'aria-label': '关闭', onClick: onClose },
            React.createElement(Primitives.IconCloseOutline16, { size: 16 })),
        ),
        React.createElement('h4', null, '运行状态'),
        React.createElement('div', { className: 'qqa-grid' },
          React.createElement('div', { className: 'qqa-kv' }, React.createElement('span', null, 'OneBot 连接'), React.createElement('b', null, React.createElement('span', { className: 'dot ' + (status && status.onebot_connected ? 'ok' : 'bad') }), status && status.onebot_connected ? ' 在线' : ' 离线')),
          React.createElement('div', { className: 'qqa-kv' }, React.createElement('span', null, 'QQ 登录'), React.createElement('b', null, React.createElement('span', { className: 'dot ' + (status && status.onebot_login ? 'ok' : 'bad') }), status && status.onebot_login ? ' ✓' : ' ✗')),
          React.createElement('div', { className: 'qqa-kv' }, React.createElement('span', null, 'DSH 模型'), React.createElement('b', null, React.createElement('span', { className: 'dot ' + (status && status.llm_configured ? 'ok' : 'bad') }), status ? ' ' + (status.llm_model || '未配置') : '')),
          React.createElement('div', { className: 'qqa-kv' }, React.createElement('span', null, 'DSH 接入'), React.createElement('b', null, React.createElement('span', { className: 'dot ' + (status && status.dsh_online ? 'ok' : 'bad') }), status && status.dsh_enabled ? (status.dsh_online ? ' 在线' : ' 离线') : ' 未启用')),
        ),
        React.createElement('div', { className: 'qqa-section' },
          React.createElement('h4', null, 'QQ 登录'),
          React.createElement('iframe', { className: 'qqa-login-frame', src: 'http://127.0.0.1:6099/webui/', title: 'NapCat QQ 扫码登录' }),
          React.createElement('div', { className: 'qqa-login-actions' },
            React.createElement('button', { className: 'qqa-btn', disabled: serviceBusy, onClick: onToggleService }, serviceBusy ? '操作中…' : (allServicesOn ? '停止服务' : '启动服务')),
            React.createElement('button', { className: 'qqa-btn', disabled: serviceBusy, onClick: onRestartService }, serviceBusy ? '操作中…' : '重启服务'),
            React.createElement('button', { className: 'qqa-btn', onClick: onOpenLogin }, status && status.onebot_login ? '打开 NapCat 登录管理' : '打开 QQ 扫码登录'),
          ),
        ),
        React.createElement(SessionBindingEditor, { sessions, agents: catalog.agents, workspaces: catalog.workspaces, models: catalog.models, onSave: onSaveSessionBinding, onToggleAuto: onToggleSessionAuto, onDeleteBinding: onDeleteSessionBinding }),
        React.createElement(RulesSection, null),
        React.createElement(ChatSection, { sessions, logs }),
      );
    }

    const inject = ['slots', 'connection'];
    function apply(ctx) {
      const slots = ctx.get('slots');
        const connection = ctx.get('connection');
      if (slots === undefined || connection === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-qq-autoreply');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      }, 'qq-autoreply: styles');

    // ---- Root component: hooks MUST live inside a React component, not apply() ----
    function QQAutoReplyApp({ wide }) {
      // shared store: status / logs / sessions + poll
      const [store, setStore] = React.useState({ status: null, logs: null, sessions: null, panelOpen: false });
      const [err, setErr] = React.useState('');
      const [service, setService] = React.useState({ busy: false, note: '' });

        const [catalog, setCatalog] = React.useState({ models: [], agents: [], workspaces: [], selectedModel: '', selectedAgent: '', selectedWorkspace: '', note: '' });
        const dshApi = connection.api;

        const loadDshCatalog = useCallback(async () => {
          try {
            const [modelsResponse, agentsResponse, workspacesResponse] = await Promise.all([
              dshApi.llm.models({}), dshApi.agentPresets.list({}), dshApi.workspace.list({}),
            ]);
            const modelValue = modelsResponse.result && modelsResponse.result.ok ? modelsResponse.result.value : { groups: [] };
            const models = (modelValue.groups || []).flatMap((g) => (g.models || []).map((m) => ({
              value: `${g.id}:${m.id}`, label: `${g.name || g.id} / ${m.name || m.id}`,
            })));
            const agentValue = agentsResponse.result && agentsResponse.result.ok ? agentsResponse.result.value : {};
            const agents = (agentValue.presets || agentValue.items || []).filter((a) => !a.broken).map((a) => ({
              id: a.id, label: a.name || a.id,
            }));
            const workspaceValue = workspacesResponse.result && workspacesResponse.result.ok ? workspacesResponse.result.value : {};
            const workspaces = (workspaceValue.items || []).map((w) => ({
              id: w.workspaceId || w.id, path: w.path, label: w.title || w.path || w.workspaceId || w.id,
            }));
            setCatalog((old) => ({ ...old, models, agents, workspaces, selectedModel: localStorage.getItem('dsh-qq-autoreply.model') || '', selectedAgent: localStorage.getItem('dsh-qq-autoreply.agent') || '', selectedWorkspace: localStorage.getItem('dsh-qq-autoreply.workspace') || '', note: '' }));
          } catch (e) {
            setCatalog((old) => ({ ...old, note: `DSH 配置读取失败：${String(e.message || e)}` }));
          }
        }, [dshApi]);

        useEffect(() => { loadDshCatalog(); }, [loadDshCatalog]);

        const selectDshValue = useCallback(async (kind, value) => {
          const key = `dsh-qq-autoreply.${kind}`;
          if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
          setCatalog((old) => ({ ...old, [kind === 'model' ? 'selectedModel' : kind === 'agent' ? 'selectedAgent' : 'selectedWorkspace']: value }));
          if (kind === 'model' && value) {
            const model = value.split(':').slice(1).join(':');
            const provider = value.split(':')[0];
            try { await arExec('config_set', { batch: { 'llm.provider': provider, 'llm.model': model, 'engine.dsh.enabled': true, 'engine.dsh.base_url': 'http://127.0.0.1:3081' } }); } catch (e) { setErr(String(e.message || e)); }
          }
          if (kind === 'agent' && value) {
            try {
              const response = await dshApi.agentPresets.read({ agentPreset: value });
              if (response.result && response.result.ok) {
                  const content = response.result.value.content;
                  const prompt = typeof content === 'string' ? content : JSON.stringify(content || {});
                  const info = await arExec('agent_info', { agent_preset: value, preset_content: content });
                  const tools = (info && info.tools) || [];
                  setCatalog((old) => ({ ...old, agentTools: tools }));
                  await arExec('config_set', { batch: {
                    'persona.system_prompt': prompt,
                    'engine.dsh.agent_preset': value,
                    'engine.dsh.reply_tools': tools.map((t) => t.id),
                  } });
                }
            } catch (e) { setErr(String(e.message || e)); }
          }
          if (kind === 'workspace' && value) {
            const workspace = catalog.workspaces.find((w) => w.id === value);
            if (workspace && workspace.path) {
              try {
                await arExec('config_set', { batch: {
                  'engine.workspace_dir': workspace.path,
                  'engine.session_dir': `${workspace.path}/.dsh/qq-autoreply`,
                } });
              } catch (e) { setErr(String(e.message || e)); }
            }
          }
        }, []);

        const openLogin = useCallback(() => {
          window.open('http://127.0.0.1:6099/webui/', '_blank', 'noopener,noreferrer');
        }, []);
      const refresh = useCallback(async () => {
        try {
          const st = await arExec('status');
          if (st && (st.onebot_connected !== undefined)) {
            setStore((s) => ({ ...s, status: st }));
            try {
              const logs = await arExec('logs', { limit: 6 });
              setStore((s) => ({ ...s, logs: (logs && logs.logs) || [] }));
            } catch { /* logs optional */ }
            try {
              const sess = await arExec('sessions', { limit: 5 });
              setStore((s) => ({ ...s, sessions: (sess && sess.sessions) || [] }));
            } catch { /* sessions optional */ }
          } else {
            setStore((s) => ({ ...s, status: OFF_STATUS }));
          }
          setErr('');
        } catch (e) {
          setStore((s) => ({ ...s, status: OFF_STATUS }));
          setErr(String(e.message || e));
        }
      }, []);

      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
      }, [refresh]);
useEffect(() => {
          const ws = new WebSocket('ws://127.0.0.1:8001/api/ws/live');
          ws.onmessage = () => refresh();
          ws.onerror = () => {};
          return () => { try { ws.close(); } catch (_) {} };
        }, [refresh]);

      const toggleMaster = useCallback(async (val) => {
        try {
          await arExec('config_set', { path: 'engine.master_switch', value: val });
          refresh();
        } catch (e) { setErr(String(e.message || e)); }
      }, [refresh]);

      const allServicesOn = !!(
        store.status && store.status.onebot_connected && store.status.master_switch
      );

      const toggleService = useCallback(async () => {
        if (service.busy) return;
        const action = allServicesOn ? 'stop' : 'start';
        setService({ busy: true, note: '' });
        try {
          const r = await arExec('service_control', { action });
          setService({
            busy: false,
            note: (r && r.note) || (allServicesOn ? '自动回复已停止' : '服务已启动'),
          });
          if (r && r.status) {
            setStore((s) => ({ ...s, status: r.status }));
          }
          refresh();
        } catch (e) {
          setService({ busy: false, note: String(e.message || e) });
        }
      }, [allServicesOn, refresh, service.busy]);

      const restartService = useCallback(async () => {
        if (service.busy) return;
        setService({ busy: true, note: '重启中…' });
        try {
          const r = await arExec('service_control', { action: 'restart' });
          setService({ busy: false, note: (r && r.note) || '已重启' });
          if (r && r.status) setStore((s) => ({ ...s, status: r.status }));
          refresh();
        } catch (e) {
          setService({ busy: false, note: String(e.message || e) });
        }
      }, [refresh, service.busy]);

      const saveSessionBinding = useCallback(async (body) => {
        let dshSessionId = body.dsh_session_id || '';
        if (!dshSessionId) {
          const d = await jsonPost('/dsh-qq/session', { action: 'create', chat_key: body.chat_key });
          dshSessionId = d && d.result && d.result.session ? d.result.session.id : '';
        }
        await arExec('session_binding', { ...body, dsh_session_id: dshSessionId });
        refresh();
      }, [refresh]);

      const toggleSessionAuto = useCallback(async (chatKey, autoOn) => {
        try {
          await arExec('session_auto', { chat_key: chatKey, auto_on: autoOn });
          refresh();
        } catch (e) { setErr(String(e.message || e)); }
      }, [refresh]);

      const deleteSessionBinding = useCallback(async (chatKey) => {
        try {
          await arExec('session_binding', { chat_key: chatKey, agent_preset: '', model_provider: '', model_name: '', workspace_dir: '', session_dir: '', dsh_session_id: '' });
          refresh();
        } catch (e) { setErr(String(e.message || e)); }
      }, [refresh]);

      const togglePanel = useCallback(() => {
        setStore((s) => ({ ...s, panelOpen: !s.panelOpen }));
      }, []);

      return React.createElement(React.Fragment, null,
        React.createElement(StatusBar, { wide, onTogglePanel: togglePanel }),
        store.panelOpen ? React.createElement(DetailPanel, {
          status: store.status, logs: store.logs, sessions: store.sessions,
          onRefresh: refresh, onToggleMaster: toggleMaster,
          serviceBusy: service.busy, serviceNote: service.note,
          allServicesOn, onToggleService: toggleService, onRestartService: restartService, catalog,
          onOpenLogin: openLogin,
            onSaveSessionBinding: saveSessionBinding,
            onToggleSessionAuto: toggleSessionAuto,
            onDeleteSessionBinding: deleteSessionBinding,
            onClose: () => setStore((s) => ({ ...s, panelOpen: false })),
        }) : null,
      );
    }

      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'qq-autoreply-control', order: 90, label: 'QQ 自动回复' },
        (props) => React.createElement(QQAutoReplyApp, props),
      )), 'qq-autoreply: sidebar control');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

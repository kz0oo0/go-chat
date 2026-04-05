/**
 * GoChat — クライアントサイドスクリプト
 *
 * 機能:
 * - WebSocket接続・メッセージ管理
 * - 通常チャット / 面接練習（部屋コード付き） / GD練習 の3モード
 * - 画像アップロード（fetch + FormData）
 * - 画像拡大モーダル
 * - GD共有メモのリアルタイム同期
 * - 面接官専用チャット（面接官ロールのみ受信）
 */

'use strict';

console.log('GoChat Client v2.1 (Sync Enhanced) Loading...');

/* ═══════════════════════════════════════════════════════════
   状態管理
═══════════════════════════════════════════════════════════ */
const state = {
  username:     '',
  mode:         'chat',   // 'chat' | 'interview' | 'gd'
  role:         '',
  ws:           null,
  isConnected:  false,
  selectedFile: null,
  sendTarget:   'main',   // 'main' | 'sub'（面接練習時）
  currentRoom:  'main',   // 'main' | 'secret'（ルーム切替）
  gdNote: {               // GD共有メモの現在値
    theme: '', premise: '', issues: '',
    opinions: '', conclusion: '', summary: '',
    editMode: 'secretary',
  },
  noteUpdateTimer: null,  // メモ自動送信用タイマー
  activeDmUser: null,     // 現在DMを開いている相手のユーザー名
  dmHistory: {},          // 相手名 → DMメッセージ配列
  passcode: '',           // 部屋コード
  dmSelectedFile: null,   // DMパネルの選択中画像
  unreadDms:      {},     // 相手名 → 未読数
  autoReconnectCount: 0,
};

/* ═══════════════════════════════════════════════════════════
   DOM要素
═══════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const el = {
  // 画面
  loginScreen:    $('login-screen'),
  chatScreen:     $('chat-screen'),

  // 入室フォーム
  inputUsername:  $('input-username'),
  passcodeGroup:  $('passcode-group'),
  inputPasscode:  $('input-passcode'),
  usernameError:  $('username-error'),
  modeCards:      document.querySelectorAll('input[name="mode"]'),
  roleGroup:      $('role-group'),
  selectRole:     $('select-role'),
  btnJoin:        $('btn-join'),

  // ヘッダー
  headerModeBadge: $('header-mode-badge'),
  headerRoleBadge: $('header-role-badge'),
  headerPasscodeBadge: $('header-passcode-badge'),
  headerUsername:  $('header-username'),

  // タブ（スマホ）
  mobileTabs:   $('mobile-tabs'),
  tabChat:      $('tab-chat'),
  tabUsers:     $('tab-users'),
  tabSub:       $('tab-sub'),

  // パネル
  chatFooter:   document.querySelector('.chat-footer'),
  panelMain:    $('panel-main'),
  panelSub:     $('panel-sub'),
  sidebarUsers: $('sidebar-users'),
  messages:     $('messages'),
  interviewerPanel: $('interviewer-panel'),
  interviewerMessages: $('interviewer-messages'),
  gdPanel:      $('gd-panel'),

  // GDメモ
  noteTheme:      $('note-theme'),
  notePremise:    $('note-premise'),
  noteIssues:     $('note-issues'),
  noteOpinions:   $('note-opinions'),
  noteConclusion: $('note-conclusion'),
  noteSummary:    $('note-summary'),
  notePrivate:    $('note-private'),
  noteEditControl: $('note-edit-control'),
  btnToggleEditMode: $('btn-toggle-edit-mode'),
  btnClearNote:      $('btn-clear-note'),

  // 入力エリア
  inputTargetSelector: $('input-target-selector'),
  btnTargetMain:  $('btn-target-main'),
  btnTargetSub:   $('btn-target-sub'),
  inputMessage:   $('input-message'),
  btnImage:       $('btn-image'),
  fileInput:      $('file-input'),
  imagePrevArea:  $('image-preview-area'),
  imagePrevThumb: $('image-preview-thumb'),
  btnRemoveImage: $('btn-remove-image'),
  btnSend:        $('btn-send'),

  // ルーム切替
  roomSelector:  $('room-selector'),
  secretMessages: $('secret-messages'),
  gdMessages:    $('gd-messages'),
  chatPanelTitle: $('chat-panel-title'),

  // モーダル
  imageModal:   $('image-modal'),
  modalOverlay: $('modal-overlay'),
  modalClose:   $('modal-close'),
  modalImage:   $('modal-image'),

  // ステータス
  connStatus:   $('connection-status'),
  reconnectToast: $('reconnect-toast'),

  // モード切替パネル
  btnSwitchMode:     $('btn-switch-mode'),
  modeSwitchOverlay: $('mode-switch-overlay'),
  modeSwitchBackdrop:$('mode-switch-backdrop'),
  btnCloseModeSwitch:$('btn-close-mode-switch'),
  swModeRadios:      document.querySelectorAll('input[name="sw-mode"]'),
  swPasscodeGroup:   $('sw-passcode-group'),
  swInputPasscode:   $('sw-input-passcode'),
  swRoleGroup:       $('sw-role-group'),
  swSelectRole:      $('sw-select-role'),
  btnApplyMode:      $('btn-apply-mode'),

  // サイドバー（ユーザーリスト）
  userCountBadge:    $('user-count-badge'),
  userList:          $('user-list'),

  // DMパネル
  dmOverlay:         $('dm-overlay'),
  dmPanelUsername:   $('dm-panel-username'),
  btnCloseDm:        $('btn-close-dm'),
  dmMessages:        $('dm-messages'),
  dmInput:           $('dm-input'),
  btnDmSend:         $('btn-dm-send'),
  btnDmImage:        $('btn-dm-image'),
  dmFileInput:       $('dm-file-input'),
  dmImagePrevArea:   $('dm-image-preview-area'),
  dmImagePrevThumb:  $('dm-image-preview-thumb'),
  btnDmRemoveImage:  $('btn-dm-remove-image'),

  // 通知・タイマー [NEW]
  logoutBtn:         $('btn-logout'),
  toastContainer:    $('toast-container'),
  tkTimerPanel:      $('tk-timer-panel'),
  tkTimerSetup:      $('tk-timer-setup'),
  tkTimerRunning:    $('tk-timer-running'),
  selectTkMin:       $('select-tk-min'),
  selectTkSec:       $('select-tk-sec'),
  tkTimerDisplay:    $('tk-timer-display'),
  btnTkTimerStartSetup: $('btn-tk-timer-start-setup'),
  btnTkTimerCancelSetup: $('btn-tk-timer-cancel-setup'),
  btnTkTimerCancel:  $('btn-tk-timer-cancel'),
  btnTkTimerPause:   $('btn-tk-timer-pause'),
};

/* ═══════════════════════════════════════════════════════════
   役割定義
═══════════════════════════════════════════════════════════ */
const ROLES = {
  chat: [],
  interview: [
    { value: 'interviewer',  label: '面接官' },
    { value: 'student',      label: '就活生' },
    { value: 'observer',     label: '見学者' },
  ],
  gd: [
    { value: 'leader',      label: 'リーダー' },
    { value: 'timekeeper',  label: 'タイムキーパー' },
    { value: 'secretary',   label: '書記' },
    { value: 'presenter',   label: '発表者' },
    { value: 'observer',    label: '見学者' },
    { value: 'interviewer', label: '面接官' },
  ],
};

const MODE_LABELS = {
  chat:      '通常チャット',
  interview: '面接練習',
  gd:        'GD練習',
};

const ROLE_LABELS = {
  interviewer:  '面接官',
  student:      '就活生',
  observer:     '見学者',
  leader:       'リーダー',
  timekeeper:   'タイムキーパー',
  secretary:    '書記',
  presenter:    '発表者',
  participant:  '参加者',
};

/* ═══════════════════════════════════════════════════════════
   入室フォームのロジック
═══════════════════════════════════════════════════════════ */

/** モード変更時にUIを更新する (役割と部屋コードの出し分け) */
function onModeChange(mode) {
  state.mode = mode;

  // 役割の出し分け
  const roles = ROLES[mode];
  if (!roles || roles.length === 0) {
    el.roleGroup.classList.add('hidden');
    state.role = '';
  } else {
    el.selectRole.innerHTML = roles
      .map(r => `<option value="${r.value}">${r.label}</option>`)
      .join('');
    state.role = roles[0].value;
    el.roleGroup.classList.remove('hidden');
  }

  // 部屋コードは常に表示（個人間やり取り用）
  el.passcodeGroup.classList.remove('hidden');
}

/** モードカードのchange検知 */
el.modeCards.forEach(radio => {
  radio.addEventListener('change', () => onModeChange(radio.value));
});

/** 役割セレクト変更 */
el.selectRole.addEventListener('change', () => {
  state.role = el.selectRole.value;
  saveLoginState();
});

/** 入室ボタン */
el.btnJoin.addEventListener('click', () => joinChat());

/** Enterキーで入室 */
el.inputUsername.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinChat();
});

function joinChat() {
  const name = el.inputUsername.value.trim();
  if (!name) {
    el.usernameError.classList.remove('hidden');
    el.inputUsername.classList.add('input-error');
    el.inputUsername.focus();
    return;
  }

  el.usernameError.classList.add('hidden');
  el.inputUsername.classList.remove('input-error');

  state.username = name;
  state.passcode = el.inputPasscode.value.trim();
  state.mode     = document.querySelector('input[name="mode"]:checked')?.value || 'chat';
  state.role     = el.selectRole.value || '';

  // 画面遷移
  el.loginScreen.classList.add('hidden');
  el.chatScreen.classList.remove('hidden');

  // ヘッダー更新
  el.headerUsername.textContent = state.username;
  updateHeaderBadges();

  // UIのモード設定
  setupModeUI();

  // WebSocket接続
  connectWebSocket();
  saveLoginState(); // ログイン情報を保存
}

/** ヘッダーのバッジを更新 */
function updateHeaderBadges() {
  if (!el.headerModeBadge) return;
  el.headerModeBadge.textContent = MODE_LABELS[state.mode] || state.mode;
  
  // 通常チャット（chat）モードではロール等を表示しない
  const showRole = state.mode !== 'chat';
  if (showRole && state.role) {
    el.headerRoleBadge.textContent = ROLE_LABELS[state.role] || state.role;
    el.headerRoleBadge.classList.remove('hidden');
  } else {
    el.headerRoleBadge.classList.add('hidden');
  }

  // 部屋コードバッジ
  if (state.passcode) {
    el.headerPasscodeBadge.textContent = `🔑 ${state.passcode}`;
    el.headerPasscodeBadge.classList.remove('hidden');
  } else {
    el.headerPasscodeBadge.classList.add('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════
   モード別UIセットアップ
═══════════════════════════════════════════════════════════ */
function setupModeUI() {
  const { mode, role } = state;

  // タイマーや通知等のフローティングUIリセット
  el.tkTimerPanel.classList.add('hidden');

  // まずすべてのサブUI要素をリセット
  el.panelSub.classList.add('hidden');
  el.mobileTabs.classList.add('hidden');
  el.tabSub.classList.add('hidden');
  el.inputTargetSelector.classList.add('hidden');
  el.interviewerPanel.classList.add('hidden');
  el.gdPanel.classList.add('hidden');
  el.noteEditControl.classList.add('hidden');
  el.panelMain.classList.remove('hidden');
  el.chatFooter.classList.remove('hidden');

  // スマホの場合は常にタブを表示（チャット・参加者）
  if (window.innerWidth <= 768) {
    el.mobileTabs.classList.remove('hidden');
    switchTab('chat');
  }

  // 送信先を全体に戻す
  setSendTarget('main');

  // GDメッセージエリアをリセット（通常/面接モードは通常メッセージエリアを使用）
  el.messages.classList.remove('hidden');
  el.gdMessages.classList.add('hidden');

  // ── 通常チャット ──────────────────────────
  if (mode === 'chat') return;

  // ── 面接練習 ──────────────────────────────
  if (mode === 'interview') {
    if (role === 'interviewer') {
      el.interviewerPanel.classList.remove('hidden');
      showSubPanel();
      el.tabSub.classList.remove('hidden');
      el.inputTargetSelector.classList.remove('hidden');
      el.tabSub.textContent = '面接官チャット';
    }
    return;
  }

  // ── GD練習 ────────────────────────────────
  if (mode === 'gd') {
    // GD専用チャットエリアに切替（面接モードのエリアと分離）
    el.messages.classList.add('hidden');
    el.gdMessages.classList.remove('hidden');

    el.gdPanel.classList.remove('hidden');
    showSubPanel();
    el.tabSub.classList.remove('hidden');
    el.tabSub.textContent = '共有メモ';
    if (role !== 'observer') {
      el.noteEditControl.classList.remove('hidden');
    }
    updateNoteEditability();
    setupNoteListeners();

    // タイムキーパーならタイマーを表示
    if (state.role === 'timekeeper') {
      console.log('Timer visibility: forcing display for timekeeper');
      if (el.tkTimerPanel) {
        el.tkTimerPanel.classList.remove('hidden');
        el.tkTimerPanel.style.display = 'flex';
      }
    } else {
      if (el.tkTimerPanel) {
        el.tkTimerPanel.classList.add('hidden');
        el.tkTimerPanel.style.display = 'none';
      }
    }
  }
}

/** サブパネルを表示（PC + スマホタブ） */
function showSubPanel() {
  el.panelSub.classList.remove('hidden');

  // スマホタブ表示
  if (window.innerWidth <= 768) {
    el.mobileTabs.classList.remove('hidden');
    switchTab('chat');
  }
}

/* ═══════════════════════════════════════════════════════════
   スマホタブ切替
═══════════════════════════════════════════════════════════ */
el.tabChat.addEventListener('click', () => switchTab('chat'));
el.tabUsers.addEventListener('click', () => switchTab('users'));
el.tabSub.addEventListener('click',  () => switchTab('sub'));

function switchTab(tab) {
  const isMobile = window.innerWidth <= 768;
  if (!isMobile) return;

  state.activeTab = tab; // 追加: アクティブなタブを保存
  saveLoginState();      // 追加

  el.tabChat.classList.toggle('active', tab === 'chat');
  el.tabUsers.classList.toggle('active', tab === 'users');
  el.tabSub.classList.toggle('active',  tab === 'sub');

  // 表示の切り替え
  if (tab === 'chat') {
    el.panelMain.style.display = '';
    el.sidebarUsers.classList.remove('active');
    el.panelSub.style.display  = 'none';
    el.chatFooter.classList.remove('hidden');
    setSendTarget('main');
  } else if (tab === 'users') {
    el.panelMain.style.display = 'none';
    el.sidebarUsers.classList.add('active');
    el.panelSub.style.display  = 'none';
    el.chatFooter.classList.add('hidden');
  } else {
    el.panelMain.style.display = 'none';
    el.sidebarUsers.classList.remove('active');
    el.panelSub.style.display  = '';
    
    // サブパネル時のフッター表示制御
    if (state.mode === 'gd') {
      el.chatFooter.classList.add('hidden');
    } else {
      el.chatFooter.classList.remove('hidden');
      if (state.mode === 'interview') {
        setSendTarget('sub');
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   WebSocket接続
═══════════════════════════════════════════════════════════ */
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.addEventListener('open', () => {
    state.isConnected = true;
    setConnectionStatus('connected');
    el.reconnectToast.classList.add('hidden'); // 接続成功時にメッセージを隠す

    // joinメッセージを送信
    sendWsMessage({
      type:     'join',
      username: state.username,
      mode:     state.mode,
      role:     state.role,
      passcode: state.passcode,
    });
  });

  state.ws.addEventListener('message', e => {
    const lines = e.data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        handleMessage(msg);
      } catch (err) {
        console.error('JSON parse error:', err, line);
      }
    }
  });

  state.ws.addEventListener('close', () => {
    state.isConnected = false;
    setConnectionStatus('disconnected');
    el.reconnectToast.classList.remove('hidden');

    // 5秒後に再接続試行
    setTimeout(() => {
      if (!state.isConnected && state.username) {
        tryReconnect();
      }
    }, 5000);
  });

  state.ws.addEventListener('error', err => {
    console.error('WebSocket error:', err);
    setConnectionStatus('disconnected');
  });
}

function sendWsMessage(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      console.error('WebSocket送信エラー:', e);
      return false;
    }
  }
  console.warn('WebSocketが接続されていません。');
  return false;
}

function setConnectionStatus(status) {
  el.connStatus.className = `status-dot status-${status}`;
  const titles = { connecting:'接続中...', connected:'接続済み', disconnected:'切断' };
  el.connStatus.title = titles[status] || status;
}

/* ═══════════════════════════════════════════════════════════
   メッセージ受信ハンドラ
═══════════════════════════════════════════════════════════ */
function handleMessage(msg) {
  // GDモードのチャットはGD専用エリアへ、それ以外は通常エリアへ
  const mainContainer = state.mode === 'gd' ? el.gdMessages : el.messages;

  switch (msg.type) {
    case 'text':
      appendTextMessage(msg, mainContainer);
      break;

    case 'image':
      appendImageMessage(msg, mainContainer);
      break;

    case 'system':
      appendSystemMessage(msg.content, mainContainer);
      break;

    case 'secret_chat':
      appendTextMessage(msg, el.secretMessages);
      // シークレットルームを見ていない場合は通知
      if (state.currentRoom !== 'secret') {
        markSecretUnread();
      }
      break;

    case 'interviewer_chat':
      if (state.role !== 'interviewer') return;
      appendTextMessage(msg, el.interviewerMessages, true);
      break;

    case 'note_update':
      if (msg.note) applyNoteUpdate(msg.note);
      break;

    case 'clear_note':
      clearGDNoteUI();
      break;

    case 'history_sep':
      appendHistorySep(msg.content);
      break;

    case 'deleted':
      appendDeletedPlaceholder(msg, mainContainer);
      break;

    case 'delete':
      handleDeleteEvent(msg.id);
      break;

    case 'user_list':
      updateUserList(msg.users);
      break;

    case 'dm':
      handleDmMessage(msg);
      break;

    case 'error':
      // 入室画面へ戻す。alert前にクリアすることでCloseイベント時の再接続を防ぐ
      state.username = '';
      alert(msg.content);
      el.chatScreen.classList.add('hidden');
      el.loginScreen.classList.remove('hidden');
      el.reconnectToast.classList.add('hidden');
      break;
  }
}

/* ═══════════════════════════════════════════════════════════
   メッセージ表示
═══════════════════════════════════════════════════════════ */

/** タイムスタンプを HH:MM 形式に変換 */
function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
  } catch { return ''; }
}

function isMine(username) {
  return username === state.username;
}

/** テキストメッセージをDOMに追加 */
function appendTextMessage(msg, container, isInterviewerChat = false) {
  const mine = isMine(msg.username);
  const div = document.createElement('div');
  const classNames = [
    'msg',
    mine ? 'msg-mine' : 'msg-theirs',
    isInterviewerChat ? 'msg-interviewer-chat' : '',
  ];
  div.className = classNames.filter(Boolean).join(' ');
  
  if (msg.id) div.dataset.msgId = msg.id;

  div.innerHTML = `
    <div class="msg-content-wrap">
      ${!mine ? `<div class="msg-meta"><span class="msg-meta-name">${escHtml(msg.username)}</span><span>${formatTime(msg.timestamp)}</span></div>` : ''}
      <div class="msg-bubble">${escHtml(msg.content)}</div>
      ${mine ? `<div class="msg-meta"><span>${formatTime(msg.timestamp)}</span></div>` : ''}
    </div>
  `;

  // 自分のメッセージに取り消しボタンを追加（左側に配置）
  if (mine && msg.id) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button class="btn-delete-msg" title="取り消す" onclick="requestDelete('${escHtml(msg.id)}')">&#x2715;</button>`;
    div.insertBefore(actions, div.firstChild);
  }

  container.appendChild(div);
  scrollToBottom(container);
}

/** 画像メッセージをDOMに追加 */
function appendImageMessage(msg, container) {
  const mine = isMine(msg.username);
  const div = document.createElement('div');
  div.className = `msg ${mine ? 'msg-mine' : 'msg-theirs'}`;
  if (msg.id) div.dataset.msgId = msg.id;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'msg-content-wrap';
  
  contentWrap.innerHTML = `
    ${!mine ? `<div class="msg-meta"><span class="msg-meta-name">${escHtml(msg.username)}</span><span>${formatTime(msg.timestamp)}</span></div>` : ''}
  `;

  const img = document.createElement('img');
  img.src = msg.content;
  img.alt = '画像';
  img.className = 'msg-image';
  img.loading = 'lazy';
  img.addEventListener('click', () => openModal(msg.content));
  contentWrap.appendChild(img);

  if (mine) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${formatTime(msg.timestamp)}</span>`;
    contentWrap.appendChild(meta);
  }

  div.appendChild(contentWrap);

  // 自分のメッセージに取り消しボタンを追加（画像も左側）
  if (mine && msg.id) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button class="btn-delete-msg" title="取り消す" onclick="requestDelete('${escHtml(msg.id)}')">&#x2715;</button>`;
    div.insertBefore(actions, div.firstChild);
  }

  container.appendChild(div);
  scrollToBottom(container);
}

/** システムメッセージをDOMに追加 */
function appendSystemMessage(content, container) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = content;
  container.appendChild(div);
  scrollToBottom(container);
}

/** 履歴区切り表示と画面クリア */
function appendHistorySep(type) {
  const mainContainer = state.mode === 'gd' ? el.gdMessages : el.messages;

  if (type === 'start') {
    el.messages.innerHTML = '';
    el.gdMessages.innerHTML = '';
    el.interviewerMessages.innerHTML = '';
    return;
  }

  const div = document.createElement('div');
  div.className = 'history-sep';
  div.textContent = '── 新しいメッセージ ──';
  mainContainer.appendChild(div);
}

/** 履歴再生時の「取り消し済み」プレースホルダー */
function appendDeletedPlaceholder(msg, container) {
  const mine = isMine(msg.username);
  const div = document.createElement('div');
  div.className = `msg ${mine ? 'msg-mine' : 'msg-theirs'}`;
  div.innerHTML = `
    ${!mine ? `<div class="msg-meta"><span class="msg-meta-name">${escHtml(msg.username)}</span></div>` : ''}
    <div class="msg-bubble msg-bubble-deleted">⧘ このメッセージは取り消されました</div>
  `;
  container.appendChild(div);
  scrollToBottom(container);
}

/** リアルタイム削除イベント */
function handleDeleteEvent(id) {
  if (!id) return;
  [el.messages, el.gdMessages, el.interviewerMessages, el.dmMessages].forEach(container => {
    const msgEl = container.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!msgEl) return;
    msgEl.removeAttribute('data-msg-id');
    msgEl.querySelectorAll('.msg-actions').forEach(a => a.remove());
    const bubble = msgEl.querySelector('.msg-bubble');
    if (bubble) {
      bubble.className = 'msg-bubble msg-bubble-deleted';
      bubble.innerHTML = 'このメッセージは取り消されました';
    } else {
      const img = msgEl.querySelector('.msg-image');
      if (img) {
        const placeholder = document.createElement('div');
        placeholder.className = 'msg-bubble msg-bubble-deleted';
        placeholder.innerHTML = '⧘ このメッセージは取り消されました';
        img.replaceWith(placeholder);
      }
    }
  });
}

/** 取り消しリクエスト（グローバル関数） */
function requestDelete(id) {
  sendWsMessage({ type: 'delete', id });
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════
   メッセージ送信
═══════════════════════════════════════════════════════════ */

el.inputMessage.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

el.inputMessage.addEventListener('input', () => {
  updateSendButton();
  el.inputMessage.style.height = 'auto';
  el.inputMessage.style.height = Math.min(el.inputMessage.scrollHeight, 120) + 'px';
});

el.btnSend.addEventListener('click', sendMessage);

function updateSendButton() {
  const hasText  = el.inputMessage.value.trim().length > 0;
  const hasImage = state.selectedFile !== null;
  el.btnSend.disabled = !hasText && !hasImage;
}

async function sendMessage() {
  if (el.btnSend.disabled) return;

  const text = el.inputMessage.value.trim();

  if (state.selectedFile) {
    await uploadAndSendImage(text);
    return;
  }

  if (!text) return;

  // シークレットルームの場合はsecret_chatとして送信
  if (state.currentRoom === 'secret') {
    sendWsMessage({ type: 'secret_chat', content: text, noHistory: true });
  } else {
    const msgType = (state.mode === 'interview' && state.sendTarget === 'sub')
      ? 'interviewer_chat'
      : 'text';
    sendWsMessage({ type: msgType, content: text });
  }

  el.inputMessage.value = '';
  el.inputMessage.style.height = 'auto';
  updateSendButton();
}

/* ═══════════════════════════════════════════════════════════
   画像アップロード
═══════════════════════════════════════════════════════════ */

el.btnImage.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    alert('対応していないファイル形式です（jpg/jpeg/png/webp のみ）');
    el.fileInput.value = '';
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    alert('ファイルサイズが大きすぎます（上限5MB）');
    el.fileInput.value = '';
    return;
  }

  state.selectedFile = file;

  const reader = new FileReader();
  reader.onload = ev => {
    el.imagePrevThumb.src = ev.target.result;
    el.imagePrevArea.classList.remove('hidden');
  };
  reader.readAsDataURL(file);

  updateSendButton();
});

el.btnRemoveImage.addEventListener('click', () => {
  clearSelectedImage();
});

function clearSelectedImage() {
  state.selectedFile = null;
  el.fileInput.value = '';
  el.imagePrevThumb.src = '';
  el.imagePrevArea.classList.add('hidden');
  updateSendButton();
}

async function uploadAndSendImage(captionText) {
  const file = state.selectedFile;
  if (!file) return;

  const formData = new FormData();
  formData.append('image', file);

  el.chatScreen.classList.add('uploading');
  el.btnSend.disabled = true;

  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const json = await resp.json();

    if (json.error) {
      alert(`アップロード失敗: ${json.error}`);
      return;
    }

    if (state.currentRoom === 'secret') {
      sendWsMessage({ type: 'secret_chat', content: json.url, noHistory: true });
      if (captionText) sendWsMessage({ type: 'secret_chat', content: captionText, noHistory: true });
    } else {
      const msgType = (state.mode === 'interview' && state.sendTarget === 'sub')
        ? 'interviewer_chat'
        : 'image';
      sendWsMessage({ type: msgType, content: json.url });
      if (captionText) sendWsMessage({ type: 'text', content: captionText });
    }

    el.inputMessage.value = '';
    el.inputMessage.style.height = 'auto';
    clearSelectedImage();
  } catch (err) {
    console.error('Upload error:', err);
    alert('画像のアップロードに失敗しました');
  } finally {
    el.chatScreen.classList.remove('uploading');
    updateSendButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   面接練習: 送信先切替
═══════════════════════════════════════════════════════════ */
el.btnTargetMain.addEventListener('click', () => setSendTarget('main'));
el.btnTargetSub.addEventListener('click',  () => setSendTarget('sub'));

function setSendTarget(target) {
  state.sendTarget = target;
  el.btnTargetMain.classList.toggle('active', target === 'main');
  el.btnTargetSub.classList.toggle('active',  target === 'sub');

  const placeholder = target === 'sub'
    ? 'メッセージを入力...'
    : 'メッセージを入力...';
  el.inputMessage.placeholder = placeholder;
}

/* ═══════════════════════════════════════════════════════════
   GD共有メモ
═══════════════════════════════════════════════════════════ */

const noteFields = [
  { el: el.noteTheme,      key: 'theme' },
  { el: el.notePremise,    key: 'premise' },
  { el: el.noteIssues,     key: 'issues' },
  { el: el.noteOpinions,   key: 'opinions' },
  { el: el.noteConclusion, key: 'conclusion' },
  { el: el.noteSummary,    key: 'summary' },
];

function setupNoteListeners() {
  noteFields.forEach(({ el: textarea, key }) => {
    textarea.addEventListener('input', () => {
      if (!canEditNote()) return;
      state.gdNote[key] = textarea.value;
      clearTimeout(state.noteUpdateTimer);
      state.noteUpdateTimer = setTimeout(sendNoteUpdate, 300);
    });
  });

  // 自分用メモの処理（ローカル保存のみ）
  if (el.notePrivate) {
    el.notePrivate.value = localStorage.getItem('gd_private_memo') || '';
    el.notePrivate.addEventListener('input', () => {
      localStorage.setItem('gd_private_memo', el.notePrivate.value);
    });
  }
}

function canEditNote() {
  const { editMode } = state.gdNote;
  if (editMode === 'all') return true;
  if (editMode === 'secretary' && state.role === 'secretary') return true;
  return false;
}

function updateNoteEditability() {
  const editable = canEditNote();
  noteFields.forEach(({ el: textarea }) => {
    textarea.disabled = !editable;
  });

  // 自分用メモは常に編集可能
  if (el.notePrivate) {
    el.notePrivate.disabled = false;
  }

  // バッジの表示切り替え
  const badges = document.querySelectorAll('.note-readonly-badge');
  badges.forEach(badge => {
    if (editable) {
      badge.classList.add('hidden');
    } else {
      badge.classList.remove('hidden');
    }
  });

  // 編集権限の切替ボタンは書記のみ表示
  if (el.btnToggleEditMode) {
    el.btnToggleEditMode.classList.toggle('hidden', state.role !== 'secretary');
    el.btnToggleEditMode.textContent =
      state.gdNote.editMode === 'secretary' ? '書記のみ' : '全員';
  }

  // 削除ボタンの表示制御
  if (el.btnClearNote) {
    // 見学者以外なら削除ボタンを表示
    el.btnClearNote.classList.toggle('hidden', state.role === 'observer');
  }
}

el.btnToggleEditMode.addEventListener('click', () => {
  if (state.role !== 'secretary') return;
  state.gdNote.editMode = state.gdNote.editMode === 'secretary' ? 'all' : 'secretary';
  updateNoteEditability();
  sendNoteUpdate();
});

el.btnClearNote.addEventListener('click', () => {
  if (state.role === 'observer') return;
  console.log('DEBUG: Clear button clicked');
  if (!confirm('共有メモ（自分用以外）をすべて削除してよろしいですか？')) return;

  console.log('DEBUG: Sending clear_note message...');
  // サーバーへ削除リクエスト送信
  const sent = sendWsMessage({ type: 'clear_note' });
  
  if (sent) {
    console.log('DEBUG: Clear_note message sent to server.');
    clearGDNoteUI();
  } else {
    alert('サーバーとの接続が切れているため、削除できません。');
  }
});

function clearGDNoteUI() {
  const keys = ['theme', 'premise', 'issues', 'opinions', 'conclusion', 'summary'];
  keys.forEach(k => {
    state.gdNote[k] = '';
    const textarea = $(`note-${k}`);
    if (textarea) textarea.value = '';
  });
  clearTimeout(state.noteUpdateTimer);
  state.gdNote.editMode = 'secretary';
  updateNoteEditability();
}

function sendNoteUpdate() {
  sendWsMessage({
    type: 'note_update',
    note: { ...state.gdNote },
  });
}

function applyNoteUpdate(note) {
  const focused = document.activeElement;
  
  // すべてのフィールドが空かチェック（一括削除の判定）
  const keys = ['theme', 'premise', 'issues', 'opinions', 'conclusion', 'summary'];
  const isAllEmpty = keys.every(k => !note[k]);

  noteFields.forEach(({ el: textarea, key }) => {
    if (note[key] !== undefined) {
      // 内部状態はフォーカスに関わらず常に更新（上書き防止）
      state.gdNote[key] = note[key];
      
      // UIの更新: フォーカスしていない場合、または一括削除（全空）の場合は強制反映
      if (textarea !== focused || isAllEmpty) {
        textarea.value = note[key];
      }
    }
  });

  if (note.editMode !== undefined) {
    state.gdNote.editMode = note.editMode;
    updateNoteEditability();
  }
}

/* ═══════════════════════════════════════════════════════════
   画像拡大モーダル
═══════════════════════════════════════════════════════════ */
function openModal(src) {
  el.modalImage.src = src;
  el.imageModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  el.imageModal.classList.add('hidden');
  el.modalImage.src = '';
  document.body.style.overflow = '';
}

el.modalClose.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', closeModal);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeModeSwitch();
  }
});

/* ═══════════════════════════════════════════════════════════
   モード切替パネル
═══════════════════════════════════════════════════════════ */

/** モード切替パネルを開く */
function openModeSwitch() {
  // 現在の値をセット
  const currentModeRadio = document.querySelector(`input[name="sw-mode"][value="${state.mode}"]`);
  if (currentModeRadio) currentModeRadio.checked = true;
  onSwModeChange(state.mode);
  el.swSelectRole.value = state.role;
  el.swInputPasscode.value = state.passcode;

  el.modeSwitchOverlay.classList.remove('hidden');
}

/** パネルを閉じる */
function closeModeSwitch() {
  el.modeSwitchOverlay.classList.add('hidden');
}

/** 切替パネル内のモード選択変化 */
function onSwModeChange(mode) {
  const roles = ROLES[mode];
  if (!roles || roles.length === 0) {
    el.swRoleGroup.classList.add('hidden');
  } else {
    el.swSelectRole.innerHTML = roles
      .map(r => `<option value="${r.value}">${r.label}</option>`)
      .join('');
    el.swRoleGroup.classList.remove('hidden');
  }

  // 部屋コードは常に表示
  el.swPasscodeGroup.classList.remove('hidden');
}

/** モードを切替えて適用する */
function applyModeSwitch() {
  const newMode = document.querySelector('input[name="sw-mode"]:checked')?.value || 'chat';
  const newRole = el.swSelectRole.value || '';
  const newPass = el.swInputPasscode.value.trim();

  const modeChanged = newMode !== state.mode;
  const roleChanged = newRole !== state.role;
  const passChanged = newPass !== state.passcode;

  if (!modeChanged && !roleChanged && !passChanged) {
    closeModeSwitch();
    return;
  }

  state.mode = newMode;
  state.role = newRole;
  state.passcode = newPass;

  // ヘッダーバッジ更新
  updateHeaderBadges();

  // サーバーへモード変更を通知
  sendWsMessage({
    type:     'mode_change',
    mode:     newMode,
    role:     newRole,
    passcode: newPass,
  });

  // チャット内にシステムメッセージ表示
  const modeLabel = MODE_LABELS[newMode];
  const roleLabel = (newMode !== 'chat' && newRole) ? `（${ROLE_LABELS[newRole] || newRole}）` : '';
  appendSystemMessage(`モードを「${modeLabel}${roleLabel}」に切り替えました`, el.messages);

  // UIを再構築
  setupModeUI();
  saveLoginState(); // 追加
  closeModeSwitch();
}

// イベントリスナー
el.btnSwitchMode.addEventListener('click', openModeSwitch);
el.btnCloseModeSwitch.addEventListener('click', closeModeSwitch);
el.modeSwitchBackdrop.addEventListener('click', closeModeSwitch);
el.btnApplyMode.addEventListener('click', applyModeSwitch);

el.swModeRadios.forEach(radio => {
  radio.addEventListener('change', () => onSwModeChange(radio.value));
});

/* ═══════════════════════════════════════════════════════════
   オンラインユーザー＆DM機能
═══════════════════════════════════════════════════════════ */

function updateUserList(users) {
  el.userCountBadge.textContent = users.length;
  el.userList.innerHTML = '';

  if (users.length === 0) {
    el.userList.innerHTML = '<li class="user-list-empty">誰もいません</li>';
    return;
  }

  const sorted = users.slice().sort((a, b) => {
    if (a.username === state.username) return -1;
    if (b.username === state.username) return 1;
    return a.username.localeCompare(b.username);
  });

  sorted.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-list-item';
    const isMe = u.username === state.username;
    if (isMe) li.classList.add('is-me');

    // 通常チャット（chatモード）ではロールを表示しない
    const showRole = state.mode !== 'chat';
    const roleLabel = (showRole && u.role) ? ROLE_LABELS[u.role] || u.role : '';
    const roleHtml = roleLabel ? `<span class="user-role-badge">${roleLabel}</span>` : '';
    
    // 未読バッジ
    const unread = state.unreadDms[u.username] || 0;
    const unreadHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';

    li.innerHTML = `
      <div class="user-status-dot"></div>
      <div class="user-info">
        <span class="user-name">${escHtml(u.username)}${isMe ? ' (あなた)' : ''}</span>
        ${roleHtml}
      </div>
      ${unreadHtml}
      ${!isMe ? `<button class="btn-dm-open" title="DMを送る" aria-label="DMを送る"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></button>` : ''}
    `;

    if (!isMe) {
      li.onclick = () => openDmPanel(u.username);
    }
    el.userList.appendChild(li);
  });
}

function openDmPanel(targetUser) {
  state.activeDmUser = targetUser;
  el.dmPanelUsername.textContent = targetUser;
  el.dmOverlay.classList.remove('hidden');
  el.dmInput.focus();

  // 未読をクリア
  if (state.unreadDms[targetUser]) {
    delete state.unreadDms[targetUser];
    // ユーザーリストのバッジを手動で消す
    const items = el.userList.querySelectorAll('.user-list-item');
    items.forEach(item => {
      if (item.querySelector('.user-name').textContent.includes(targetUser)) {
        const badge = item.querySelector('.unread-badge');
        if (badge) badge.remove();
      }
    });
  }

  el.dmMessages.innerHTML = '';
  const history = state.dmHistory[targetUser] || [];
  history.forEach(msg => {
    const isImage = msg.content && msg.content.startsWith('/uploads/');
    if (isImage) {
      appendImageMessage(msg, el.dmMessages);
    } else {
      appendTextMessage(msg, el.dmMessages, false);
    }
  });
  scrollToBottom(el.dmMessages);
}

function closeDmPanel() {
  el.dmOverlay.classList.add('hidden');
  state.activeDmUser = null;
}

el.btnCloseDm.addEventListener('click', closeDmPanel);

function handleDmMessage(msg) {
  const partner = msg.username === state.username ? msg.to : msg.username;
  
  state.dmHistory[partner] = state.dmHistory[partner] || [];
  if (msg.id && state.dmHistory[partner].some(m => m.id === msg.id)) return;
  state.dmHistory[partner].push(msg);

  // 画像かテキストか判定
  const isImage = msg.content && msg.content.startsWith('/uploads/');

  if (msg.username !== state.username) {
    if (state.activeDmUser === partner && !el.dmOverlay.classList.contains('hidden')) {
      // 開いている相手からのメッセージならそのまま表示
      if (isImage) {
        appendImageMessage(msg, el.dmMessages);
      } else {
        appendTextMessage(msg, el.dmMessages, false);
      }
    } else {
      // 開いていない相手からのメッセージなら通知
      state.unreadDms[partner] = (state.unreadDms[partner] || 0) + 1;
      showToast(isImage ? '[画像を受信しました]' : msg.content, msg.username);
      
      // ユーザーリストのバッジを手動更新
      const items = el.userList.querySelectorAll('.user-list-item');
      items.forEach(item => {
        if (item.querySelector('.user-name').textContent.includes(partner)) {
          let badge = item.querySelector('.unread-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'unread-badge';
            item.querySelector('.user-info').appendChild(badge);
          }
          badge.textContent = state.unreadDms[partner];
        }
      });
    }
  } else {
    // 自分の送信したメッセージ
    if (state.activeDmUser === partner) {
      if (isImage) {
        appendImageMessage(msg, el.dmMessages);
      } else {
        appendTextMessage(msg, el.dmMessages, false);
      }
    }
  }
}

async function sendDmMessage() {
  if (el.btnDmSend.disabled) return;

  const text = el.dmInput.value.trim();

  // 画像が選択されている場合は画像アップロードを優先
  if (state.dmSelectedFile) {
    await uploadAndSendDmImage(text);
    return;
  }

  if (!text || !state.activeDmUser) return;

  sendWsMessage({
    type: 'dm',
    to: state.activeDmUser,
    content: text
  });

  el.dmInput.value = '';
  updateDmSendButton();
}

el.dmInput.addEventListener('input', updateDmSendButton);
el.dmInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendDmMessage();
  }
});
el.btnDmSend.addEventListener('click', sendDmMessage);

function updateDmSendButton() {
  const hasText  = el.dmInput.value.trim().length > 0;
  const hasImage = state.dmSelectedFile !== null;
  el.btnDmSend.disabled = !hasText && !hasImage;
}

/* ═══════════════════════════════════════════════════════════
   DM画像送信
═══════════════════════════════════════════════════════════ */

el.btnDmImage.addEventListener('click', () => el.dmFileInput.click());

el.dmFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    alert('対応していないファイル形式です（jpg/jpeg/png/webp のみ）');
    el.dmFileInput.value = '';
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    alert('ファイルサイズが大きすぎます（上限5MB）');
    el.dmFileInput.value = '';
    return;
  }

  state.dmSelectedFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    el.dmImagePrevThumb.src = ev.target.result;
    el.dmImagePrevArea.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  updateDmSendButton();
});

el.btnDmRemoveImage.addEventListener('click', () => clearDmSelectedImage());

function clearDmSelectedImage() {
  state.dmSelectedFile = null;
  el.dmFileInput.value = '';
  el.dmImagePrevThumb.src = '';
  el.dmImagePrevArea.classList.add('hidden');
  updateDmSendButton();
}

async function uploadAndSendDmImage(captionText) {
  const file = state.dmSelectedFile;
  if (!file || !state.activeDmUser) return;

  const formData = new FormData();
  formData.append('image', file);

  el.btnDmSend.disabled = true;

  try {
    const resp = await fetch('/upload', { method: 'POST', body: formData });
    const json = await resp.json();

    if (json.error) {
      alert(`アップロード失敗: ${json.error}`);
      return;
    }

    // 画像URLをDMとして送信
    sendWsMessage({ type: 'dm', to: state.activeDmUser, content: json.url, msgContentType: 'image' });
    if (captionText) {
      sendWsMessage({ type: 'dm', to: state.activeDmUser, content: captionText });
    }

    el.dmInput.value = '';
    clearDmSelectedImage();
  } catch (err) {
    console.error('DM Upload error:', err);
    alert('画像のアップロードに失敗しました');
  } finally {
    updateDmSendButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   ルーム切替（メイン ↔ シークレット）
═══════════════════════════════════════════════════════════ */

el.roomSelector.addEventListener('change', () => {
  switchRoom(el.roomSelector.value);
  saveLoginState();
});

/** ルームを切替える */
function switchRoom(room) {
  state.currentRoom = room;

  if (room === 'secret') {
    el.messages.classList.add('hidden');
    el.gdMessages.classList.add('hidden'); // GD用も消す
    el.secretMessages.classList.remove('hidden');
    el.chatPanelTitle.textContent = '🔒 シークレット';
    el.inputMessage.placeholder = 'シークレットルームへ送信...';
    el.roomSelector.classList.add('is-secret');
    clearSecretUnread();
  } else {
    el.secretMessages.classList.add('hidden');
    // モードに応じて出し分け
    if (state.mode === 'gd') {
      el.gdMessages.classList.remove('hidden');
    } else {
      el.messages.classList.remove('hidden');
    }
    el.chatPanelTitle.textContent = '💬 チャット';
    el.inputMessage.placeholder = 'メッセージを入力...';
    el.roomSelector.classList.remove('is-secret');
  }

  scrollToBottom(room === 'secret' ? el.secretMessages : (state.mode === 'gd' ? el.gdMessages : el.messages));
}

/** シークレットルームの未読インジケーターを表示 */
function markSecretUnread() {
  const opt = el.roomSelector.querySelector('option[value="secret"]');
  if (opt && !opt.textContent.includes('●')) {
    opt.textContent = '🔒 シークレット ●';
  }
}

/** 未読インジケーターをクリア */
function clearSecretUnread() {
  const opt = el.roomSelector.querySelector('option[value="secret"]');
  if (opt) opt.textContent = '🔒 シークレット';
}

/* ═══════════════════════════════════════════════════════════
   初期化
═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   ログイン状態保持 (localStorage)
 ═══════════════════════════════════════════════════════════ */

function saveLoginState() {
  const data = {
    username: state.username,
    mode:     state.mode,
    role:     state.role,
    passcode: state.passcode,
    room:     state.currentRoom, // 追加
    tab:      state.activeTab,   // 追加
  };
  localStorage.setItem('gochat_auth', JSON.stringify(data));
}

function loadLoginState() {
  const saved = localStorage.getItem('gochat_auth');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      el.inputUsername.value = data.username || '';
      el.inputPasscode.value = data.passcode || '';
      if (data.mode) {
        state.mode = data.mode;
        const radio = [...el.modeCards].find(r => r.value === data.mode);
        if (radio) radio.checked = true;
        onModeChange(data.mode);
      }
      if (data.role) {
        el.selectRole.value = data.role;
        state.role = data.role;
      }
      
      if (data.room) state.currentRoom = data.room;
      if (data.tab)  state.activeTab  = data.tab;

      if (data.username) {
        // デバウンス的な遅延を入れて入室
        setTimeout(() => {
          if (!state.username) joinChat();
          
          if (state.currentRoom) {
            el.roomSelector.value = state.currentRoom;
            switchRoom(state.currentRoom);
          }
          if (state.activeTab && window.innerWidth <= 768) {
            switchTab(state.activeTab);
          }
        }, 500);
      }
    } catch (e) {
      console.warn('Failed to load login state', e);
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   通知トースト
 ═══════════════════════════════════════════════════════════ */

function showToast(content, sender = '') {
  const toast = document.createElement('div');
  toast.className = 'dm-toast';
  toast.innerHTML = `
    <div style="flex:1">
      <div style="font-weight:bold;font-size:12px;margin-bottom:2px">${sender ? sender + ' からのメッセージ' : '通知'}</div>
      <div>${content}</div>
    </div>
  `;
  toast.onclick = () => {
    if (sender) openDmPanel(sender);
    toast.remove();
  };
  el.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

/* ═══════════════════════════════════════════════════════════
   タイムキーパー機能 (タイマー & ストップウォッチ)
 ═══════════════════════════════════════════════════════════ */

// 状態管理の拡張
state.tkMode = 'timer'; // 'timer' | 'stopwatch'
state.tkTimer = {
  remainingMs: 0,
  isRunning: false,
  isPaused: false
};
state.tkStopwatch = {
  elapsedMs: 0,
  isRunning: false,
  isPaused: false
};

const elTk = {
  modeTimerBtn: $('btn-tk-mode-timer'),
  modeSwBtn:    $('btn-tk-mode-sw'),
  timerDot:     $('tk-timer-dot'),
  swDot:        $('tk-sw-dot'),
  timerSection: $('tk-timer-section'),
  swSection:    $('tk-sw-section'),
  swDisplay:    $('tk-sw-display'),
  swResetBtn:   $('btn-tk-sw-reset'),
  swStartBtn:   $('btn-tk-sw-start')
};

/** モード切替 */
elTk.modeTimerBtn.addEventListener('click', () => switchTkMode('timer'));
elTk.modeSwBtn.addEventListener('click',    () => switchTkMode('stopwatch'));

function switchTkMode(mode) {
  state.tkMode = mode;
  elTk.modeTimerBtn.classList.toggle('active', mode === 'timer');
  elTk.modeSwBtn.classList.toggle('active',    mode === 'stopwatch');
  
  elTk.timerSection.classList.toggle('hidden', mode !== 'timer');
  elTk.swSection.classList.toggle('hidden',    mode !== 'stopwatch');

  if (mode === 'timer') updateTkTimerDisplay();
  if (mode === 'stopwatch') updateTkSwDisplay();
}

/** タイマー表示更新 */
function updateTkTimerDisplay() {
  const totalSec = Math.max(0, Math.ceil(state.tkTimer.remainingMs / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  el.tkTimerDisplay.textContent = `${m}:${s}`;

  if (totalSec <= 0 && state.tkTimer.isRunning) {
    state.tkTimer.isRunning = false;
    state.tkTimer.remainingMs = 0;
    el.tkTimerDisplay.classList.add('timer-finished');
    showToast('タイマーが終了しました', '⏱ タイマー');
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    
    // UI復帰
    el.tkTimerRunning.classList.add('hidden');
    el.tkTimerSetup.classList.remove('hidden');
  } else {
    el.tkTimerDisplay.classList.remove('timer-finished');
  }
}

/** ストップウォッチ表示更新 */
function updateTkSwDisplay() {
  const ms = state.tkStopwatch.elapsedMs;
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const ds = String(Math.floor((ms % 1000) / 100)); // 0.1秒
  elTk.swDisplay.textContent = `${m}:${s}.${ds}`;
}

/** インジケーター表示更新 */
function updateTkIndicators() {
  elTk.timerDot.classList.toggle('hidden', !state.tkTimer.isRunning);
  elTk.swDot.classList.toggle('hidden', !state.tkStopwatch.isRunning);
}

/** 統合インターバル */
let tkMainInterval = null;
function startTkSystemInterval() {
  if (tkMainInterval) return;
  let lastTick = Date.now();
  tkMainInterval = setInterval(() => {
    const now = Date.now();
    const delta = now - lastTick;
    lastTick = now;

    // タイマー計算
    if (state.tkTimer.isRunning && !state.tkTimer.isPaused) {
      state.tkTimer.remainingMs -= delta;
      if (state.tkMode === 'timer') updateTkTimerDisplay();
      if (state.tkTimer.remainingMs <= 0) {
        if (state.tkMode !== 'timer') updateTkTimerDisplay(); // バックグラウンド時も一応呼ぶ
      }
    }

    // ストップウォッチ計算
    if (state.tkStopwatch.isRunning && !state.tkStopwatch.isPaused) {
      state.tkStopwatch.elapsedMs += delta;
      if (state.tkMode === 'stopwatch') updateTkSwDisplay();
    }

    updateTkIndicators();
  }, 100);
}

/** タイマー操作 */
function initTkTimerPickers() {
  if (!el.selectTkMin) return;
  el.selectTkMin.innerHTML = Array.from({length:100}, (_,i)=>`<option value="${i}">${i}</option>`).join('');
  el.selectTkSec.innerHTML = Array.from({length:12}, (_,i)=>`<option value="${i*5}">${String(i*5).padStart(2,'0')}</option>`).join('');
}
initTkTimerPickers();

el.btnTkTimerStartSetup.addEventListener('click', () => {
  const mins = parseInt(el.selectTkMin.value) || 0;
  const secs = parseInt(el.selectTkSec.value) || 0;
  if (mins === 0 && secs === 0) return;

  state.tkTimer.remainingMs = (mins * 60 + secs) * 1000;
  state.tkTimer.isRunning = true;
  state.tkTimer.isPaused = false;
  
  el.tkTimerSetup.classList.add('hidden');
  el.tkTimerRunning.classList.remove('hidden');
  updateTkTimerDisplay();
  startTkSystemInterval();
});

el.btnTkTimerPause.addEventListener('click', () => {
  state.tkTimer.isPaused = !state.tkTimer.isPaused;
  el.btnTkTimerPause.textContent = state.tkTimer.isPaused ? '再開' : '一時停止';
  el.btnTkTimerPause.className = state.tkTimer.isPaused ? 'btn-tk-round btn-tk-green' : 'btn-tk-round btn-tk-orange';
});

el.btnTkTimerCancel.addEventListener('click', () => {
  state.tkTimer.isRunning = false;
  state.tkTimer.remainingMs = 0;
  el.tkTimerRunning.classList.add('hidden');
  el.tkTimerSetup.classList.remove('hidden');
});

/** ストップウォッチ操作 */
elTk.swStartBtn.addEventListener('click', () => {
  if (!state.tkStopwatch.isRunning || state.tkStopwatch.isPaused) {
    // 開始または再開
    state.tkStopwatch.isRunning = true;
    state.tkStopwatch.isPaused = false;
    elTk.swStartBtn.textContent = '停止';
    elTk.swStartBtn.className = 'btn-tk-round btn-tk-red';
    startTkSystemInterval();
  } else {
    // 一時停止
    state.tkStopwatch.isPaused = true;
    elTk.swStartBtn.textContent = '開始';
    elTk.swStartBtn.className = 'btn-tk-round btn-tk-green';
  }
});

elTk.swResetBtn.addEventListener('click', () => {
  state.tkStopwatch.isRunning = false;
  state.tkStopwatch.isPaused = false;
  state.tkStopwatch.elapsedMs = 0;
  elTk.swStartBtn.textContent = '開始';
  elTk.swStartBtn.className = 'btn-tk-round btn-tk-green';
  updateTkSwDisplay();
});

/* ═══════════════════════════════════════════════════════════
   自動再接続 & Visibility監視
 ═══════════════════════════════════════════════════════════ */

function tryReconnect() {
  if (state.isConnected) return;
  console.log('Attempting auto-reconnect...');
  connectWebSocket();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.isConnected && state.username) {
    tryReconnect();
  }
});

/* ═══════════════════════════════════════════════════════════
   初期化 & ログアウト
 ═══════════════════════════════════════════════════════════ */

function logout() {
  if (confirm('ログアウトして入室画面に戻りますか？')) {
    localStorage.removeItem('gochat_auth');
    location.reload(); // 状態をリセットするためにリロード
  }
}

el.logoutBtn?.addEventListener('click', logout);

onModeChange('chat');
updateSendButton();
loadLoginState(); // 以前のログイン情報を復元
el.inputUsername.focus();

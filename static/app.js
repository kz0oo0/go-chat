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
  mode:         'chat',   // 'chat' | 'interview' | 'GroupDiscussion'
  role:         '',
  ws:           null,
  isConnected:  false,
  selectedFiles: [],      // 複数ファイル対応
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
  adminPass: '',          // 管理者/メンターパスワード（ヘッダー入力欄）
  dmSelectedFiles: [],     // DMパネルの選択中画像
  unreadDms:      {},     // 相手名 → 未読数
  autoReconnectCount: 0,
  isAdmin:        false,  // 管理者かどうか
  isMentor:       false,  // メンターかどうか
  isHidden:       false,  // ゴーストモードかどうか
  heartbeatTimer: null,   // Heartbeat(Ping)用タイマー
  lastPongTime:   0,      // 最後にPongを受け取った時刻
  isLoggedIn:     false,  // ログイン状態フラグ
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
  imagePrevList:  $('image-preview-list'),
  btnRemoveImage: $('btn-remove-image'),
  btnSend:        $('btn-send'),

  // ルーム切替 (カスタムドロップダウン)
  roomDropdown:   $('room-dropdown'),
  dropdownTrigger: $('room-dropdown-trigger'),
  dropdownMenu:    $('room-dropdown-menu'),
  selectedRoomLabel: $('selected-room-label'),
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

  // 管理者用
  loginAdminPass:    $('login-admin-pass'),
  headerAdminPass:   $('header-admin-pass'),
  swAdminPass:       $('sw-admin-pass'),
  btnGhostToggle:    $('btn-ghost-toggle'),
  tabAdmin:          $('tab-admin'),
  adminPeekModal:    $('admin-peek-modal'),
  peekModalOverlay:  $('peek-modal-overlay'),
  peekRoomId:        $('peek-room-id'),
  peekMessages:      $('peek-messages'),
  btnClosePeek:      $('btn-close-peek'),
  kickOverlay:       $('kick-overlay'),
  kickMessage:       $('kick-message'),
  btnRefreshRooms:   $('btn-refresh-rooms'),
  adminRoomList:     $('admin-room-list'),
  tplAdminPanel:     $('tpl-admin-panel'),

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
  dmImagePrevList:   $('dm-image-preview-list'),
  btnDmRemoveImage:  $('btn-dm-remove-image'),

  // 通知・タイマー [NEW]
  logoutBtn:         $('btn-logout'),
  logoutConfirmModal: $('logout-confirm-modal'),
  btnLogoutCancel:    $('btn-logout-cancel'),
  btnLogoutOk:        $('btn-logout-ok'),
  alertModal:         $('alert-modal'),
  alertMessage:       $('alert-modal-message'),
  btnAlertOk:         $('btn-alert-ok'),
  loginError:        $('login-error'),
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
    { value: 'student',      label: '参加者' },
    { value: 'interviewer',  label: '面接官' },
    { value: 'observer',     label: '見学者' },
  ],
  GroupDiscussion: [
    { value: 'participant',  label: '参加者' },
    { value: 'leader',       label: 'リーダー' },
    { value: 'timekeeper',   label: 'タイムキーパー' },
    { value: 'secretary',    label: '書記' },
    { value: 'presenter',    label: '発表者' },
    { value: 'interviewer',  label: '面接官' },
    { value: 'observer',     label: '見学者' },
  ],
};

const MODE_LABELS = {
  chat:      '通常チャット',
  interview: '面接練習',
  GroupDiscussion: 'GD練習',
};

const ROLE_LABELS = {
  interviewer:  '面接官',
  student:      '参加者',
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
el.btnJoin.addEventListener('click', async () => await joinChat());

/** Enterキーで入室 */
el.inputUsername.addEventListener('keydown', async e => {
  if (e.key === 'Enter') await joinChat();
});

async function joinChat(isAutoLogin = false) {
  const name = el.inputUsername.value.trim();
  if (!name) {
    el.usernameError.classList.remove('hidden');
    el.inputUsername.classList.add('input-error');
    el.inputUsername.focus();
    return;
  }

  el.usernameError.classList.add('hidden');
  el.inputUsername.classList.remove('input-error');

  // 入室前の重複チェック (手動入室時のみ)
  if (!isAutoLogin) {
    el.btnJoin.disabled = true;
    el.btnJoin.textContent = '確認中...';
    
    try {
      const resp = await fetch(`/api/check-name?name=${encodeURIComponent(name)}`);
      const result = await resp.json();
      
      if (!result.available) {
        showAlert(result.error || '同じ名前が存在する為入室出来ません。');
        return;
      }
    } catch (err) {
      console.error('Check name error:', err);
      // ネットワークエラー等の場合は、念のためそのまま進ませる
    } finally {
      el.btnJoin.disabled = false;
      el.btnJoin.textContent = '入室する';
    }
  }

  state.username  = name;
  state.passcode  = el.inputPasscode.value.trim();
  // ログイン画面のパスワード入力欄から読む（ヘッダーの要素はまだ表示されていないため）
  state.adminPass = (el.loginAdminPass ? el.loginAdminPass.value.trim() : '') ||
                   (el.headerAdminPass ? el.headerAdminPass.value.trim() : '');
  state.mode      = document.querySelector('input[name="mode"]:checked')?.value || 'chat';
  state.role      = el.selectRole.value || '';

  // 画面遷移
  el.loginScreen.classList.add('hidden');
  el.chatScreen.classList.remove('hidden');

  // ヘッダー更新
  el.headerUsername.textContent = state.username;
  updateHeaderBadges();

  // UIのモード設定
  setupModeUI();

  // WebSocket接続 (100ms遅らせて初期表示を優先させる)
  setTimeout(() => {
    connectWebSocket(isAutoLogin);
    saveLoginState(); 
  }, 100);
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
  let displayPasscode = state.passcode || '';
  displayPasscode = displayPasscode.replace(/^(GroupDiscussion|interview)\|/, '').trim();
  if (displayPasscode) {
    el.headerPasscodeBadge.textContent = `🔑 ${displayPasscode}`;
    el.headerPasscodeBadge.classList.remove('hidden');
  } else {
    el.headerPasscodeBadge.classList.add('hidden');
  }

  // 権限による右上のユーザープロファイル（ボタン全体）の縁取り処理（紫＝管理者、緑＝メンター、両方＝半分）
  if (!el.logoutBtn) return;
  // 一度すべて外す
  el.logoutBtn.classList.remove('border-admin', 'border-mentor', 'border-both');
  
  if (state.isAdmin && state.isMentor) {
    el.logoutBtn.classList.add('border-both');
  } else if (state.isAdmin) {
    el.logoutBtn.classList.add('border-admin');
  } else if (state.isMentor) {
    el.logoutBtn.classList.add('border-mentor');
  }
}

/* ═══════════════════════════════════════════════════════════
   モード別UIセットアップ
═══════════════════════════════════════════════════════════ */
function setupModeUI() {
  const { mode, role } = state;

  // 常にヘッダー表示を最新の状態に更新
  updateHeaderBadges();

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
  }

  // 送信先を全体に戻す
  setSendTarget('main');

  // GDメッセージエリアをリセット（通常/面接モードは通常メッセージエリアを使用）
  el.messages.classList.remove('hidden');
  el.gdMessages.classList.add('hidden');
  el.secretMessages.classList.add('hidden');

  // ルームを強制的にメインに戻す（シークレット状態での移行バグ防止）
  state.currentRoom = 'main';
  if (el.roomSelector) el.roomSelector.value = 'main';
  if (el.chatPanelTitle) {
    el.chatPanelTitle.textContent = (mode === 'GroupDiscussion') ? '💬 議論チャット' : '💬 チャット';
  }

  // ── ニュークリア・リセット (核爆弾修正) ──────────────────
  // サブパネル内のすべての子要素を例外なく一度隠す
  if (el.panelSub) {
    Array.from(el.panelSub.children).forEach(child => {
      child.classList.add('hidden');
      child.style.display = 'none';
    });
  }

  // ── 通常チャット ──────────────────────────
  if (mode === 'chat') {
    el.panelSub.classList.add('hidden');
    // 早期リターンを削除し、共通の後処理（タブ更新等）が走るようにする
    updateHeaderBadges();
  }

  console.log(`[UI] setupModeUI: mode=${mode}, role=${role}`);

  // ── 面接練習 ──────────────────────────────
  if (mode === 'interview') {
    // GD系を確実に隔離
    if (el.gdMessages) el.gdMessages.classList.add('hidden');
    el.messages.classList.remove('hidden');

    if (role === 'interviewer' || state.isAdmin) {
      if (el.interviewerPanel) {
        el.interviewerPanel.classList.remove('hidden');
        el.interviewerPanel.style.display = 'flex';
      }
      showSubPanel();
      el.tabSub.classList.remove('hidden');
      el.inputTargetSelector.classList.remove('hidden');
      // スマホタブ名を具体的に変更
      if (window.innerWidth <= 768) {
        el.tabSub.textContent = '面接官チャット';
      } else {
        el.tabSub.textContent = 'サブパネル';
      }
      // 面接官専用チャットの入力欄（管理者の場合は常に表示）
      const isInterviewer = (state.role === 'interviewer' || state.isAdmin);
    } else {
      el.panelSub.classList.add('hidden');
      el.tabSub.classList.add('hidden');
    }
  }

  // ── GD練習 (GroupDiscussion) ──────────────────────
  if (mode === 'GroupDiscussion') {
    // GD専用チャットエリアに切替
    el.messages.classList.add('hidden');
    el.gdMessages.classList.remove('hidden');

    if (el.gdPanel) {
      el.gdPanel.classList.remove('hidden');
      el.gdPanel.style.display = 'flex';
    }
    showSubPanel();
    el.tabSub.classList.remove('hidden');
    // スマホタブ名を具体的に変更
    if (window.innerWidth <= 768) {
      el.tabSub.textContent = '共有メモ';
    } else {
      el.tabSub.textContent = 'サブパネル';
    }
    // 全ユーザーにコントロールを表示
    el.noteEditControl.classList.remove('hidden');
    updateNoteEditability();
    setupNoteListeners();

    // タイムキーパーまたは管理者の場合はタイマーを表示
    if (state.role === 'timekeeper' || state.isAdmin) {
      if (el.tkTimerPanel) {
        el.tkTimerPanel.classList.remove('hidden');
        el.tkTimerPanel.style.display = 'flex';
      }
    }
  }

  // 最後に適切なスマホタブを選択状態にする
  if (window.innerWidth <= 768) {
    let targetTab = state.activeTab || 'chat';
    // 'sub'タブの内容がない（通常モード等）のに'sub'が選ばれている場合は'chat'に戻す
    const hasSubContent = (mode === 'GroupDiscussion' || (mode === 'interview' && (role === 'interviewer' || state.isAdmin)));
    if (targetTab === 'sub' && !hasSubContent) {
      targetTab = 'chat';
    }
    // 管理者でないのに'admin'タブが選ばれている場合は'chat'に戻す
    if (targetTab === 'admin' && !state.isAdmin) {
      targetTab = 'chat';
    }
    switchTab(targetTab);
  }

  // ヘッダーのバッジ（部屋コード等）を最新状態に更新
  updateHeaderBadges();
}

/** サブパネルを表示（PC + スマホタブ） */
function showSubPanel() {
  el.panelSub.classList.remove('hidden');

  // スマホタブ表示
  if (window.innerWidth <= 768) {
    el.mobileTabs.classList.remove('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════
   スマホタブ切替
═══════════════════════════════════════════════════════════ */
el.tabChat.addEventListener('click', () => switchTab('chat'));
el.tabUsers.addEventListener('click', () => switchTab('users'));
el.tabSub.addEventListener('click',  () => switchTab('sub'));
if (el.tabAdmin) el.tabAdmin.addEventListener('click', () => switchTab('admin'));

function switchTab(tab) {
  const isMobile = window.innerWidth <= 768;
  if (!isMobile) return;

  console.log(`[Tab] Switching to: ${tab}`);
  state.activeTab = tab;
  saveLoginState();

  // タブボタンの状態更新
  el.tabChat.classList.toggle('active', tab === 'chat');
  el.tabUsers.classList.toggle('active', tab === 'users');
  el.tabSub.classList.toggle('active',  tab === 'sub');
  if (el.tabAdmin) {
    el.tabAdmin.classList.toggle('active', tab === 'admin');
  }

  // 全パネルを一旦完全に非表示にする
  const panels = [
    { el: el.panelMain, name: 'chat' },
    { el: el.sidebarUsers, name: 'users' },
    { el: el.panelSub, name: 'sub' },
    { el: $( 'admin-panel' ), name: 'admin' }
  ];
  
  panels.forEach(p => {
    if (p.el) {
      p.el.style.display = 'none';
      p.el.classList.add('hidden');
      p.el.classList.remove('active', 'active-mobile-panel');
    }
  });

  // フッター（チャット入力欄）の制御：チャットタブ以外では完全に隠す
  if (tab === 'chat') {
    el.chatFooter.classList.remove('hidden');
    el.chatFooter.style.display = 'block';
  } else {
    el.chatFooter.classList.add('hidden');
    el.chatFooter.style.display = 'none';
  }

  // 選択されたタブに応じた表示
  if (tab === 'chat') {
    el.panelMain.style.display = 'flex';
    el.panelMain.classList.remove('hidden');
    el.panelMain.classList.add('active-mobile-panel');
    setSendTarget('main');
  } else if (tab === 'users') {
    el.sidebarUsers.style.display = 'flex';
    el.sidebarUsers.classList.remove('hidden');
    el.sidebarUsers.classList.add('active', 'active-mobile-panel');
  } else if (tab === 'admin') {
    const adminPanel = $('admin-panel');
    if (adminPanel) {
      adminPanel.style.display = 'flex';
      adminPanel.classList.remove('hidden');
      adminPanel.classList.add('active-mobile-panel');
      sendWsMessage({ type: 'admin_get_rooms' });
    }
  } else if (tab === 'sub') {
    el.panelSub.style.display = 'flex'; // flexに変更して中身の縦並びを維持
    el.panelSub.classList.remove('hidden');
    el.panelSub.classList.add('active-mobile-panel');

    // 面接モードの場合は送信先を自動でサブ（面接官チャット）に切り替える
    if (state.mode === 'interview' && (state.role === 'interviewer' || state.isAdmin)) {
      setSendTarget('sub');
    }
    
    // サブパネル内のコンテンツ出し分け
    const isGD = state.mode === 'GroupDiscussion';
    const isInterview = state.mode === 'interview';
    
    if (el.interviewerPanel) {
      el.interviewerPanel.style.display = isInterview ? 'flex' : 'none';
      el.interviewerPanel.classList.toggle('hidden', !isInterview);
    }
    if (el.gdPanel) {
      el.gdPanel.style.display = isGD ? 'flex' : 'none';
      el.gdPanel.classList.toggle('hidden', !isGD);
    }
  }

  // スクロール位置のトップリセット（切り替え時の違和感解消）
  window.scrollTo(0, 0);
}

/* ═══════════════════════════════════════════════════════════
   WebSocket接続
═══════════════════════════════════════════════════════════ */
function connectWebSocket(isAutoLogin = false) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;

  state.ws = new WebSocket(wsUrl);
  
  // 2秒間 CONNECTING のままならリセットして再試行 (スマホのフォアグラウンド対策)
  const connectionTimeout = setTimeout(() => {
    if (state.ws.readyState === WebSocket.CONNECTING) {
      console.warn('WebSocket stuck in CONNECTING. Retrying...');
      state.ws.close();
      tryReconnect();
    }
  }, 2000);

  state.ws.addEventListener('open', () => {
    clearTimeout(connectionTimeout); // 成功したらタイマー解除
    state.isConnected = true;
    state.isLoggedIn = true; // 接続成功＆join送信をログイン状態とみなす
    setConnectionStatus('connected');
    el.reconnectToast.classList.add('hidden'); // 接続成功時にメッセージを隠す

    sendWsMessage({
      type:       'join',
      username:   state.username,
      mode:       state.mode,
      role:       state.role,
      passcode:   state.passcode,
      admin_pass: state.adminPass,
      isMobile:   isMobile(),
      isHidden:   state.isHidden, // 隠密状態をサーバーへ通知
      isAutoLogin: isAutoLogin,   // WebSocket側での重複チェックをスキップするフラグ
    });

    startHeartbeat(); // 接続成功時にHeartbeat開始
  });

  state.ws.addEventListener('message', e => {
    const lines = e.data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'pong') {
          state.lastPongTime = Date.now();
          return;
        }
        handleMessage(msg);
      } catch (err) {
        console.error('JSON parse error:', err, line);
      }
    }
  });

  state.ws.addEventListener('close', () => {
    state.isConnected = false;
    stopHeartbeat(); // 切断時はタイマー停止
    setConnectionStatus('disconnected');

    // チャット画面が表示中かつログイン状態(isLoggedIn)が有効なときだけ再接続
    const onChatScreen = !el.chatScreen.classList.contains('hidden');
    if (!state.isLoggedIn || !onChatScreen || !state.username) {
      // ログイン画面またはキック画面の場合は再接続しない
      el.reconnectToast.classList.add('hidden');
      return;
    }

    el.reconnectToast.classList.remove('hidden');

    // 3秒後に再接続試行（ログイン中かつチャット画面表示中のみ）
    setTimeout(() => {
      if (!state.isConnected && state.isLoggedIn && state.username && !el.chatScreen.classList.contains('hidden')) {
        tryReconnect();
      }
    }, 3000);
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
  if (msg.type === 'welcome') {
    const oldPass = state.passcode;
    const oldMode = state.mode;

    state.isAdmin = !!msg.isAdmin;
    state.isMentor = !!msg.isMentor;
    state.isHidden = !!msg.isHidden;
    
    // サーバーから通知された現在の状態を一括反映
    if (msg.mode) state.mode = msg.mode;
    if (msg.role) state.role = msg.role;
    if (!state.mode) state.mode = 'chat';
    
    if (typeof msg.passcode !== 'undefined') {
      // 合言葉から接頭辞を除去してクリーンな状態を保つ
      let cleanPass = msg.passcode.replace(/^(GroupDiscussion|interview)\|/, '');
      
      // バックエンドからそのまま渡されたパスコードを正としてUIに反映する
      state.passcode = cleanPass;
    }
    
    // もし合言葉やモードが以前と違う場合（強制移動時など）
    if (oldPass !== state.passcode || oldMode !== state.mode) {
      if (el.messages) el.messages.innerHTML = '';
      if (el.gdMessages) el.gdMessages.innerHTML = '';
      if (el.interviewerMessages) el.interviewerMessages.innerHTML = '';

      // 履歴を再要求
      sendWsMessage({ type: 'get_history', passcode: msg.passcode });
      
      // シークレットルーム等にいた場合はメインに戻す
      if (state.currentRoom !== 'main') {
        switchRoom('main');
      }
    }

    setupModeUI();
    setupAdminUI();
    updateHeaderBadges();
    saveLoginState();
    
    console.log('Handshake successful - Welcome received (Admin:', state.isAdmin, ', Room:', state.passcode, ')');
    return;
  }
  
  // 全体通知の最優先処理 (合言葉やモードを無視して確実にポップアップを出す)
  if (msg.type === 'system' && msg.content && msg.content.startsWith('[全体通知]')) {
    const cleanMsg = msg.content.replace('[全体通知] ', '');
    showToast(cleanMsg, '⚙ システム');
    
    // 現在アクティブなコンテナにのみ追加（重複表示を防ぐ）
    const activeContainer = state.mode === 'GroupDiscussion' ? el.gdMessages : el.messages;
    if (activeContainer) appendSystemMessage(msg.content, activeContainer);
    return; // 以降の通常処理（モード判定等）を行わずに終了
  }

  // GDモードのチャットはGD専用エリアへ、それ以外は通常エリアへ
  const mainContainer = state.mode === 'GroupDiscussion' ? el.gdMessages : el.messages;

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
      {
        const isImage = msg.content && msg.content.startsWith('/uploads/');
        if (isImage) {
          appendImageMessage(msg, el.secretMessages);
        } else {
          appendTextMessage(msg, el.secretMessages);
        }
        // シークレットルームを見ていない場合は通知
        if (state.currentRoom !== 'secret') {
          markSecretUnread();
        }
      }
      break;

    case 'interviewer_chat':
      if (state.role !== 'interviewer' && !state.isAdmin) return;
      {
        const isImage = msg.content && msg.content.startsWith('/uploads/');
        if (isImage) {
          appendImageMessage(msg, el.interviewerMessages, true);
        } else {
          appendTextMessage(msg, el.interviewerMessages, true);
        }
      }
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

    case 'kicked':
      handleKicked(msg.content);
      break;

    case 'user_renamed':
      handleUserRenamed(msg.username, msg.content);
      break;

    case 'room_reset':
      handleRoomReset(msg.content);
      break;

    case 'admin_rooms_list':
      renderAdminRoomList(msg.users);
      break;

    case 'admin_peek_history':
      renderPeekHistory(msg.users);
      break;

    case 'action_error':
      showAlert(msg.content);
      break;

    case 'error':
      // ポップアップでエラーを表示
      showAlert(msg.content);
      
      state.username = '';
      localStorage.removeItem('gochat_auth');
      el.chatScreen.classList.add('hidden');
      el.loginScreen.classList.remove('hidden');
      el.reconnectToast.classList.add('hidden');
      break;
  }
}

/* ═══════════════════════════════════════════════════════════
   メッセージ表示
═══════════════════════════════════════════════════════════ */

/** タイムスタンプを HH:MM 形式に変換（24時間以上前なら月日も追加） */
function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const timeStr = d.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
    
    // 24時間(86400000ミリ秒)以上前なら日付も表示
    if (diffMs >= 24 * 60 * 60 * 1000) {
      const month = d.getMonth() + 1;
      const day = d.getDate();
      return `${month}/${day} ${timeStr}`;
    }
    return timeStr;
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

  // 管理者ラベルの生成 (なりすまし防止のためアイコン風の文字バッジ化)
  const adminLabel = msg.isAdmin ? `<span class="chat-admin-badge" title="管理者" style="display:inline-flex; align-items:center; justify-content:center; background:var(--accent-dim); color:var(--accent-hover); border:1px solid var(--accent); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">管理者</span>` : '';
  const mentorLabel = msg.isMentor ? `<span class="chat-mentor-badge" title="メンター" style="display:inline-flex; align-items:center; justify-content:center; background:rgba(34, 197, 94, 0.1); color:#22c55e; border:1px solid rgba(34, 197, 94, 0.4); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">メンター</span>` : '';
  const roleLabel = (msg.mode !== 'chat' && msg.role) ? `<span style="font-size:10px; opacity:0.8; margin-left:4px; font-weight:normal; white-space: nowrap;">(${ROLE_LABELS[msg.role] || msg.role})</span>` : '';

  div.innerHTML = `
    <div class="msg-content-wrap">
      ${!mine ? `<div class="msg-meta"><span class="msg-meta-name" style="display:inline-flex; align-items:center; gap:2px; flex-wrap: wrap;">${escHtml(msg.username)}${adminLabel}${mentorLabel}${roleLabel}</span><span>${formatTime(msg.timestamp)}</span></div>` : ''}
      <div class="msg-bubble">${escHtml(msg.content)}</div>
      ${mine ? `<div class="msg-meta"><span>${formatTime(msg.timestamp)}</span></div>` : ''}
    </div>
  `;

  // 管理者、または自分のメッセージに取り消しボタンを表示
  if (msg.id && (mine || state.isAdmin)) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `<button class="btn-delete-msg" title="取り消す" onclick="requestDelete('${escHtml(msg.id)}')">&#x2715;</button>`;
    div.insertBefore(actions, div.firstChild);
  }

  container.appendChild(div);
  scrollToBottom(container);
}

/** 画像メッセージをDOMに追加 */
function appendImageMessage(msg, container, isInterviewerChat = false) {
  const mine = isMine(msg.username);
  const div = document.createElement('div');
  const classNames = [
    'msg',
    mine ? 'msg-mine' : 'msg-theirs',
    isInterviewerChat ? 'msg-interviewer-chat' : '',
  ];
  div.className = classNames.filter(Boolean).join(' ');
  if (msg.id) div.dataset.msgId = msg.id;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'msg-content-wrap';
  
  const adminLabel = msg.isAdmin ? `<span class="chat-admin-badge" title="管理者" style="display:inline-flex; align-items:center; justify-content:center; background:var(--accent-dim); color:var(--accent-hover); border:1px solid var(--accent); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">管理者</span>` : '';
  const mentorLabel = msg.isMentor ? `<span class="chat-mentor-badge" title="メンター" style="display:inline-flex; align-items:center; justify-content:center; background:rgba(34, 197, 94, 0.1); color:#22c55e; border:1px solid rgba(34, 197, 94, 0.4); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">メンター</span>` : '';
  const roleLabel = (msg.mode !== 'chat' && msg.role) ? `<span style="font-size:10px; opacity:0.8; margin-left:4px; font-weight:normal;">(${ROLE_LABELS[msg.role] || msg.role})</span>` : '';

  contentWrap.innerHTML = `
    ${!mine ? `<div class="msg-meta"><span class="msg-meta-name">${escHtml(msg.username)}${adminLabel}${mentorLabel}${roleLabel}</span><span>${formatTime(msg.timestamp)}</span></div>` : ''}
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

  // 管理者、または自分のメッセージに取り消しボタンを追加（画像も左側）
  if ((mine || state.isAdmin) && msg.id) {
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
  const mainContainer = state.mode === 'GroupDiscussion' ? el.gdMessages : el.messages;

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
  [el.messages, el.gdMessages, el.interviewerMessages, el.dmMessages, el.secretMessages].forEach(container => {
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
  const hasImage = state.selectedFiles.length > 0;
  el.btnSend.disabled = !hasText && !hasImage;
}

async function sendMessage() {
  if (el.btnSend.disabled) return;

  const text = el.inputMessage.value.trim();

  if (state.selectedFiles.length > 0) {
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

/** プレビュー画像の描画（複数対応） */
function renderPreviewThumbnails(files, container, area, type) {
  container.innerHTML = '';
  if (files.length === 0) {
    area.classList.add('hidden');
    return;
  }

  area.classList.remove('hidden');
  files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'preview-item';

    const img = document.createElement('img');
    img.className = 'preview-thumb';
    const reader = new FileReader();
    reader.onload = ev => { img.src = ev.target.result; };
    reader.readAsDataURL(file);

    const btn = document.createElement('btn');
    btn.className = 'btn-remove-single';
    btn.innerHTML = '✕';
    btn.onclick = (e) => {
      e.stopPropagation();
      if (type === 'main') {
        state.selectedFiles.splice(index, 1);
        renderPreviewThumbnails(state.selectedFiles, el.imagePrevList, el.imagePrevArea, 'main');
        updateSendButton();
      } else {
        state.dmSelectedFiles.splice(index, 1);
        renderPreviewThumbnails(state.dmSelectedFiles, el.dmImagePrevList, el.dmImagePrevArea, 'dm');
        updateDmSendButton();
      }
    };

    item.appendChild(img);
    item.appendChild(btn);
    container.appendChild(item);
  });
}

el.btnImage.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const newFiles = state.selectedFiles.concat(files);
  let totalSize = 0;

  for (const f of newFiles) {
    if (!allowedTypes.includes(f.type)) {
      alert(`未対応の形式が含まれています: ${f.name}`);
      el.fileInput.value = '';
      return;
    }
    totalSize += f.size;
  }

  if (totalSize > 30 * 1024 * 1024) {
    alert('合計サイズが30MBを超えています');
    el.fileInput.value = '';
    return;
  }

  state.selectedFiles = newFiles;
  renderPreviewThumbnails(state.selectedFiles, el.imagePrevList, el.imagePrevArea, 'main');
  el.fileInput.value = '';
  updateSendButton();
});

el.btnRemoveImage.addEventListener('click', () => {
  state.selectedFiles = [];
  el.fileInput.value = '';
  renderPreviewThumbnails([], el.imagePrevList, el.imagePrevArea, 'main');
  updateSendButton();
});

async function uploadAndSendImage(captionText) {
  if (state.selectedFiles.length === 0) return;

  const files = state.selectedFiles;
  state.selectedFiles = [];
  renderPreviewThumbnails([], el.imagePrevList, el.imagePrevArea, 'main');

  el.chatScreen.classList.add('uploading');
  el.btnSend.disabled = true;
  const originalPlaceholder = el.inputMessage.placeholder;

  try {
    for (let i = 0; i < files.length; i++) {
       const file = files[i];
       if (files.length > 1) {
         el.inputMessage.placeholder = `${i+1}/${files.length} 枚目を送信中...`;
       }

       const formData = new FormData();
       formData.append('image', file);

       const resp = await fetch('/upload', { method: 'POST', body: formData });
       const json = await resp.json();

       if (json.error) {
         alert(`${file.name} の送信に失敗しました`);
         continue;
       }

       // 1枚ごとに個別の吹き出しとして送信
       if (state.currentRoom === 'secret') {
         sendWsMessage({ type: 'secret_chat', content: json.url, noHistory: true });
       } else {
         const msgType = (state.mode === 'interview' && state.sendTarget === 'sub')
           ? 'interviewer_chat'
           : 'image';
         sendWsMessage({ type: msgType, content: json.url });
       }
    }

    if (captionText && captionText.trim()) {
      if (state.currentRoom === 'secret') {
        sendWsMessage({ type: 'secret_chat', content: captionText, noHistory: true });
      } else {
        const msgType = (state.mode === 'interview' && state.sendTarget === 'sub')
          ? 'interviewer_chat'
          : 'text';
        sendWsMessage({ type: msgType, content: captionText });
      }
    }

    el.inputMessage.value = '';
    el.inputMessage.style.height = 'auto';
  } catch (err) {
    console.error('Multi-upload error:', err);
    alert('画像の送信中にエラーが発生しました');
  } finally {
    el.chatScreen.classList.remove('uploading');
    el.inputMessage.placeholder = originalPlaceholder;
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
    // 初期化時に高さを調整
    adjustNoteHeight(textarea, true);

    // 手動リサイズ検知: mouseup で高さが前回と異なれば手動リサイズ済みとしてマーク
    textarea.addEventListener('mouseup', () => {
      const h = parseFloat(textarea.style.height);
      if (h && h !== textarea._autoHeight) {
        textarea._manualHeight = h;
      }
    });

    textarea.addEventListener('input', () => {
      if (!canEditNote()) return;
      adjustNoteHeight(textarea, false);
      state.gdNote[key] = textarea.value;
      clearTimeout(state.noteUpdateTimer);
      state.noteUpdateTimer = setTimeout(sendNoteUpdate, 300);
    });
  });

  // 自分用メモの処理（ローカル保存のみ）
  if (el.notePrivate) {
    el.notePrivate.value = localStorage.getItem('gd_private_memo') || '';
    adjustNoteHeight(el.notePrivate, true);
    el.notePrivate.addEventListener('mouseup', () => {
      const h = parseFloat(el.notePrivate.style.height);
      if (h && h !== el.notePrivate._autoHeight) {
        el.notePrivate._manualHeight = h;
      }
    });
    el.notePrivate.addEventListener('input', () => {
      adjustNoteHeight(el.notePrivate, false);
      localStorage.setItem('gd_private_memo', el.notePrivate.value);
    });
  }
}

/**
 * 共有メモtextareaの高さを自動調整する。
 * @param {HTMLTextAreaElement} textarea
 * @param {boolean} force - true: 手動リサイズ状態を無視して強制リセット（初期化・リモート更新時）
 *                          false: 手動リサイズで大きくされたサイズは保持、必要なら拡張のみ
 */
function adjustNoteHeight(textarea, force = false) {
  if (!textarea) return;

  // scrollHeightを計算するため一旦heightをautoに（実際の描画前に測定）
  const prev = textarea.style.height;
  textarea.style.height = 'auto';
  const needed = textarea.scrollHeight;
  textarea.style.height = prev; // 一旦戻す

  if (force) {
    // 強制リセット: 手動リサイズ状態をクリアしてテキスト量に合わせる
    textarea._manualHeight = null;
    textarea._autoHeight = needed;
    textarea.style.height = needed + 'px';
  } else {
    // 通常モード: 手動リサイズで広げたサイズを超えないよう、大きい方を使う
    const manual = textarea._manualHeight || 0;
    const finalH = Math.max(needed, manual);
    textarea._autoHeight = needed;
    textarea.style.height = finalH + 'px';
  }
}

function canEditNote() {
  const { role, isAdmin } = state;
  const { editMode } = state.gdNote;

  // 管理者は常に編集可能
  if (isAdmin) return true;

  // 面接官(interviewer) と 見学者(observer) は常に編集不可
  if (role === 'interviewer' || role === 'observer') return false;

  // 書記(secretary) は常に編集可能
  if (role === 'secretary') return true;

  // それ以外の役割（リーダー、タイムキーパーなど）は「全員」設定の時のみ編集可能
  return editMode === 'all';
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

  // 編集権限の切替ボタンは全ユーザーに表示（書記・管理者以外は無効化）
  if (el.btnToggleEditMode) {
    el.btnToggleEditMode.classList.remove('hidden');
    el.btnToggleEditMode.disabled = (state.role !== 'secretary' && !state.isAdmin);
    el.btnToggleEditMode.textContent =
      state.gdNote.editMode === 'secretary' ? '書記のみ' : '全員';
  }

  // 削除ボタンの表示制御（全ユーザーに表示、書記・管理者以外は無効化）
  if (el.btnClearNote) {
    el.btnClearNote.classList.remove('hidden');
    el.btnClearNote.disabled = (state.role !== 'secretary' && !state.isAdmin);
  }
}

el.btnToggleEditMode.addEventListener('click', () => {
  if (state.role !== 'secretary' && !state.isAdmin) return;
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
    if (textarea) {
      textarea.value = '';
      adjustNoteHeight(textarea, true);
    }
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
        adjustNoteHeight(textarea, true);
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
  // 管理者の場合は常にコードを表示し、そうでなければ現在のパスコードをセット
  el.swInputPasscode.value = state.passcode || '';
  // 管理パスワード入力欄に現在の state.adminPass を同期
  if (el.swAdminPass) el.swAdminPass.value = state.adminPass || '';

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
  // モード切替パネルのパスワードを state とヘッダー入力欄に反映
  const newAdminPass = el.swAdminPass ? el.swAdminPass.value.trim() : state.adminPass;
  state.adminPass = newAdminPass;
  if (el.headerAdminPass) el.headerAdminPass.value = newAdminPass;

  // state の直接書き換えは行わず、サーバーからの welcome (handleMessage) を待って同期する
  // 変更の有無に関わらず、同期のためにサーバーへ通知を送る
  sendWsMessage({
    type:       'mode_change',
    mode:       newMode,
    role:       newRole,
    passcode:   newPass,
    admin_pass: newAdminPass,
  });

  closeModeSwitch();
}

// イベントリスナー
el.btnSwitchMode.addEventListener('click', openModeSwitch);
el.btnCloseModeSwitch.addEventListener('click', closeModeSwitch);
el.modeSwitchBackdrop.addEventListener('click', closeModeSwitch);
el.btnApplyMode.addEventListener('click', applyModeSwitch);

// スマホ等で入力枠をタップした際、カーソルが先頭に飛ぶのを防止して末尾にセットする
el.swInputPasscode.addEventListener('focus', function() {
  const len = this.value.length;
  // ブラウザ側のデフォルトのフォーカス位置処理が終わった直後に末尾へ上書き修正する
  setTimeout(() => {
    this.setSelectionRange(len, len);
  }, 10);
});

el.swModeRadios.forEach(radio => {
  radio.addEventListener('change', () => onSwModeChange(radio.value));
});

/* ═══════════════════════════════════════════════════════════
   オンラインユーザー＆DM機能
═══════════════════════════════════════════════════════════ */

function updateUserList(users) {
  if (!users) users = []; // 追加: usersがundefined or nullの場合に空配列として初期化
  // 隠密ONの場合、自分自身もリストから除外して表示する
  let filteredUsers = users;
  if (state.isHidden) {
    filteredUsers = users.filter(u => u.username !== state.username);
  }

  el.userCountBadge.textContent = filteredUsers.length;
  el.userList.innerHTML = '';

  if (filteredUsers.length === 0) {
    el.userList.innerHTML = '<li class="user-list-empty">参加者はいません</li>';
    return;
  }

  const sorted = filteredUsers.slice().sort((a, b) => {
    if (a.username === state.username) return -1;
    if (b.username === state.username) return 1;
    return a.username.localeCompare(b.username);
  });

  sorted.forEach(u => {
    const li = document.createElement('li');
    li.className = 'user-list-item' + (u.is_online ? '' : ' offline');
    const isMe = u.username === state.username;
    if (isMe) li.classList.add('is-me');

    // 通常チャット（chatモード）ではロールを表示しない
    const showRole = state.mode !== 'chat';
    const roleLabel = (showRole && u.role) ? ROLE_LABELS[u.role] || u.role : '';
    const roleHtml = roleLabel ? `<span class="user-role-badge">${roleLabel}</span>` : '';
    
    // 離席中ラベル
    const statusLabel = u.is_online ? '' : '<span class="user-status-offline-tag">[離席中]</span>';

    // 未読バッジ
    const unread = state.unreadDms[u.username] || 0;
    const unreadHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';

    // 管理者バッジ（ラベル形式のアイコン風バッジ）
    const adminHtml = u.isAdmin ? '<span class="admin-badge" title="管理者" style="display:inline-flex; align-items:center; justify-content:center; background:var(--accent-dim); color:var(--accent-hover); border:1px solid var(--accent); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">管理者</span>' : '';
    // メンターバッジ
    const mentorHtml = u.isMentor ? '<span class="mentor-badge" title="メンター" style="display:inline-flex; align-items:center; justify-content:center; background:rgba(34, 197, 94, 0.1); color:#22c55e; border:1px solid rgba(34, 197, 94, 0.4); font-size:10px; font-weight:bold; padding:2px 6px 1px 6px; border-radius:10px; margin-left:4px; line-height:1; vertical-align:middle;">メンター</span>' : '';

    li.innerHTML = `
      <div class="user-status-dot"></div>
      <div class="user-info">
        ${isMe ? '<div style="font-size:10px; opacity:0.6; font-weight:700; margin-bottom:1px;">(あなた)</div>' : ''}
        <div style="display:flex; align-items:center; gap:4px; width:100%; min-width:0;">
          <span class="user-name" style="min-width:0;">${escHtml(u.username)}</span>
          ${u.is_online ? '' : '<span class="user-status-offline-tag" style="flex-shrink:0;">[離席中]</span>'}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
          ${roleHtml}
          ${adminHtml}
          ${mentorHtml}
        </div>
        ${((state.isAdmin && !isMe) || (state.isMentor && !isMe && !u.isAdmin)) ? `
          <div class="admin-user-actions" style="margin-top: 4px; display: flex; gap: 4px;">
            ${u.is_online ? `<button class="btn-rename-user" onclick="event.stopPropagation(); renameUser('${escHtml(u.username)}')">改名</button>` : ''}
            <button class="btn-kick-user" onclick="event.stopPropagation(); kickUser('${escHtml(u.username)}')">退場</button>
          </div>
        ` : ''}
      </div>
      ${unreadHtml}
      ${(!isMe && u.is_online) ? `<button class="btn-dm-open" title="DMを送る" aria-label="DMを送る"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></button>` : ''}
    `;

    if (!isMe && u.is_online) {
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

/** モバイル用タブ切り替えの初期表示 */
function setupMobileTabs() {
  if (window.innerWidth <= 768) {
    const initialTab = state.activeTab || 'chat';
    switchTab(initialTab);
  }
}

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
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  const newFiles = state.dmSelectedFiles.concat(files);
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  let totalSize = 0;
  for (const f of newFiles) {
    if (!allowedTypes.includes(f.type)) {
      alert(`形式エラー: ${f.name}`);
      el.dmFileInput.value = '';
      return;
    }
    totalSize += f.size;
  }

  if (totalSize > 30 * 1024 * 1024) {
    alert('合計ファイルサイズが30MBを超えています');
    el.dmFileInput.value = '';
    return;
  }

  state.dmSelectedFiles = newFiles;
  renderPreviewThumbnails(state.dmSelectedFiles, el.dmImagePrevList, el.dmImagePrevArea, 'dm');
  el.dmFileInput.value = '';
  updateDmSendButton();
});

el.btnDmRemoveImage.addEventListener('click', () => clearDmSelectedImages());

function clearDmSelectedImages() {
  state.dmSelectedFiles = [];
  el.dmFileInput.value = '';
  renderPreviewThumbnails([], el.dmImagePrevList, el.dmImagePrevArea, 'dm');
  updateDmSendButton();
}

async function uploadAndSendDmImage(captionText) {
  if (state.dmSelectedFiles.length === 0 || !state.activeDmUser) return;

  const files = state.dmSelectedFiles;
  clearDmSelectedImages();
  el.btnDmSend.disabled = true;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('image', file);

      const resp = await fetch('/upload', { method: 'POST', body: formData });
      const json = await resp.json();

      if (json.error) {
        alert(`${file.name} アップロード失敗`);
        continue;
      }

      // 画像URLを1枚ずつDMとして送信
      sendWsMessage({ type: 'dm', to: state.activeDmUser, content: json.url, msgContentType: 'image' });
    }

    if (captionText && captionText.trim()) {
      sendWsMessage({ type: 'dm', to: state.activeDmUser, content: captionText });
    }
    el.dmInput.value = '';
  } catch (err) {
    console.error('DM Multi-upload error:', err);
    alert('DMの送信に失敗しました');
  } finally {
    updateDmSendButton();
  }
}

/* ═══════════════════════════════════════════════════════════
   ルーム切替（メイン ↔ シークレット）
═══════════════════════════════════════════════════════════ */

  // カスタムドロップダウンのイベント設定
  if (el.dropdownTrigger) {
    el.dropdownTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      el.roomDropdown.classList.toggle('open');
      el.dropdownMenu.classList.toggle('hidden');
    });
  }

  // 項目選択
  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const room = item.getAttribute('data-value');
      switchRoom(room);
      saveLoginState();
      
      // メニューを閉じる
      el.roomDropdown.classList.remove('open');
      el.dropdownMenu.classList.add('hidden');
    });
  });

  // 画面外クリックで閉じる
  document.addEventListener('click', () => {
    el.roomDropdown?.classList.remove('open');
    el.dropdownMenu?.classList.add('hidden');
  });


/** ルームを切替える */
function switchRoom(room) {
  state.currentRoom = room;

  if (room === 'secret') {
    el.messages.classList.add('hidden');
    el.gdMessages.classList.add('hidden'); // GD用も消す
    el.secretMessages.classList.remove('hidden');
    el.chatPanelTitle.textContent = '🔒 シークレットルーム';
    el.inputMessage.placeholder = 'シークレットルームへ送信...';
    clearSecretUnread();
  } else {
    el.secretMessages.classList.add('hidden');
    // モードに応じて出し分け
    if (state.mode === 'GroupDiscussion') {
      el.gdMessages.classList.remove('hidden');
    } else {
      el.messages.classList.remove('hidden');
    }
    el.chatPanelTitle.textContent = '💬 メインルーム';
    el.inputMessage.placeholder = 'メッセージを入力...';
  }

  // ドロップダウンの表示更新
  const label = room === 'secret' ? '🔒 シークレットルーム' : '🌐 メインルーム';
  if (el.selectedRoomLabel) el.selectedRoomLabel.textContent = label;
  
  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-value') === room);
  });

  scrollToBottom(room === 'secret' ? el.secretMessages : (state.mode === 'GroupDiscussion' ? el.gdMessages : el.messages));
}

/** シークレットルームの未読インジケーターを表示 */
function markSecretUnread() {
  // リスト内の項目にドットを追加
  const item = $('dropdown-item-secret');
  if (item && !item.querySelector('.unread-dot-badge')) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot-badge';
    item.appendChild(dot);
  }
  // 親ボタンにも小さくドットを表示（もし選択中でなければ）
  if (state.currentRoom !== 'secret' && el.dropdownTrigger && !el.dropdownTrigger.querySelector('.unread-dot-badge')) {
    const dot = document.createElement('span');
    dot.className = 'unread-dot-badge';
    dot.style.marginLeft = '4px';
    el.dropdownTrigger.appendChild(dot);
  }
}

/** 未読インジケーターをクリア */
function clearSecretUnread() {
  $('dropdown-item-secret')?.querySelector('.unread-dot-badge')?.remove();
  el.dropdownTrigger?.querySelectorAll('.unread-dot-badge').forEach(d => d.remove());
}

/* ═══════════════════════════════════════════════════════════
   初期化
═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   ログイン状態保持 (localStorage)
 ═══════════════════════════════════════════════════════════ */

function saveLoginState() {
  const data = {
    username:  state.username,
    mode:      state.mode,
    role:      state.role,
    passcode:  state.passcode,
    adminPass: state.adminPass,
    room:      state.currentRoom,
    tab:       state.activeTab,
    isHidden:  state.isHidden,
    isAdmin:   state.isAdmin,
    isMentor:  state.isMentor,
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
      // 管理者パスワードをログイン画面入力欄とヘッダー入力欄に復元
      if (data.adminPass) {
        if (el.loginAdminPass) {
          el.loginAdminPass.value = data.adminPass;
        }
        if (el.headerAdminPass) {
          el.headerAdminPass.value = data.adminPass;
        }
        state.adminPass = data.adminPass;
      }
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
      
      // 隠密モード等の復元
      if (typeof data.isHidden === 'boolean') {
        state.isHidden = data.isHidden;
        if (el.btnGhostToggle) {
          el.btnGhostToggle.classList.toggle('active', state.isHidden);
          el.btnGhostToggle.querySelector('span').textContent = state.isHidden ? '隠密ON' : '隠密OFF';
        }
      }
      
      // 権限の事前復元（UIのちらつき・外れを防止）
      if (typeof data.isAdmin === 'boolean') state.isAdmin = data.isAdmin;
      if (typeof data.isMentor === 'boolean') state.isMentor = data.isMentor;

      // 一般ユーザーとしてログインした場合に、古いlocalStorage情報で管理者UIが露出しないように即座に隠す
      setupAdminUI();

      if (data.username) {
        // デバウンス的な遅延を入れて入室
        setTimeout(() => {
          if (!state.username) joinChat(true);
          
          if (state.currentRoom) {
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
  elTk.swDisplay.textContent = `${m}:${s}`;
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
  connectWebSocket(true);
}

/** モバイル端末かどうか判定 */
function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!state.isConnected && state.isLoggedIn && state.username) {
      console.log('Resume: Reconnecting from visibilitychange...');
      tryReconnect();
    }
  }
});

// window.focus も同様にチェック
window.addEventListener('focus', () => {
  if (state.isLoggedIn && !state.isConnected && state.username) {
    tryReconnect();
  }
});

/* ═══════════════════════════════════════════════════════════
   Heartbeat (生存確認)
═══════════════════════════════════════════════════════════ */

function startHeartbeat() {
  stopHeartbeat(); // 既存があれば停止
  state.lastPongTime = Date.now();
  
  state.heartbeatTimer = setInterval(() => {
    if (!state.isConnected) return;
    
    // 60秒以上応答がなければ切断とみなして再接続
    const now = Date.now();
    if (now - state.lastPongTime > 60000) {
      console.warn('Heartbeat timeout - Reconnecting...');
      if (state.ws) state.ws.close();
      tryReconnect();
      return;
    }
    
    // Ping送信
    sendWsMessage({ type: 'ping' });
  }, 25000); // 25秒おきに送信
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

// window.blur も監視
window.addEventListener('blur', () => {
  if (state.isConnected && isMobile()) {
    console.log('Window blurred - sending status: away (mobile only)');
    sendWsMessage({ type: 'status_change', is_online: false });
  }
});

/* ═══════════════════════════════════════════════════════════
   初期化 & ログアウト
 ═══════════════════════════════════════════════════════════ */

function logout() {
  // カスタムモーダルを表示
  if (el.logoutConfirmModal) {
    el.logoutConfirmModal.classList.remove('hidden');
  } else {
    // 万が一モーダルがない場合は即ログアウト
    executeLogout();
  }
}

/** 実際のログアウト処理を実行 */
function executeLogout() {
  localStorage.removeItem('gochat_auth');
  state.isLoggedIn = false;
  state.username = '';

  if (state.ws && state.isConnected) {
    sendWsMessage({ type: 'logout' });
    // websocketがサーバー側から切断されたタイミング（＝サーバーが確実にログアウト処理を終えたタイミング）でリロードする
    state.ws.onclose = () => {
      location.reload();
    };
    // サーバーからの切断が遅い、または届かない場合のフォールバック
    setTimeout(() => location.reload(), 1000);
  } else {
    location.reload();
  }
}

/** ログアウト確認モーダルを閉じる */
function closeLogoutModal() {
  el.logoutConfirmModal?.classList.add('hidden');
}

/** アラートを表示 */
function showAlert(message) {
  if (el.alertModal && el.alertMessage) {
    el.alertMessage.textContent = message;
    el.alertModal.classList.remove('hidden');
  } else {
    alert(message);
  }
}

/** アラートを閉じる */
function closeAlertModal() {
  el.alertModal?.classList.add('hidden');
}

// ログアウト関連イベント
el.logoutBtn?.addEventListener('click', logout);
el.btnLogoutOk?.addEventListener('click', executeLogout);
el.btnLogoutCancel?.addEventListener('click', closeLogoutModal);
$('logout-modal-overlay')?.addEventListener('click', closeLogoutModal);

// アラート関連イベント
el.btnAlertOk?.addEventListener('click', closeAlertModal);
$('alert-modal-overlay')?.addEventListener('click', closeAlertModal);

window.addEventListener('DOMContentLoaded', () => {
  onModeChange('chat');
  updateSendButton();
  loadLoginState(); // 以前のログイン情報を復元
  setupMobileTabs(); // モバイル用タブ切り替えを初期化
  if (el.inputUsername) el.inputUsername.focus();
  
  // 初回読み込み時の不整合防止（管理者としてリロードした場合など）
  if (isMobile()) {
    setTimeout(() => {
      switchTab(state.activeTab || 'chat');
    }, 100);
  }
});

/* ═══════════════════════════════════════════════════════════
   管理者用ヘルパー関数
═══════════════════════════════════════════════════════════ */

/** 管理者UIの初期設定（降格対応も含む） */
function setupAdminUI() {
  // ゴースト機能は管理者およびメンター両方に解放
  if (state.isAdmin || state.isMentor) {
    if (el.btnGhostToggle) el.btnGhostToggle.classList.remove('hidden');
  } else {
    if (el.btnGhostToggle) el.btnGhostToggle.classList.add('hidden');
  }

  // その他の高度な管理機能（タブなど）は管理者専用
  if (state.isAdmin) {
    if (el.tabAdmin) {
      el.tabAdmin.classList.remove('hidden');
      el.tabAdmin.style.setProperty('display', 'block', 'important'); // 強制表示を最優先
    }
    
    // スーパー管理者の場合、サーバー管理パネルを有効化
    let existingAdminPanel = $('admin-panel');
    if (!existingAdminPanel && el.tplAdminPanel) {
      const clone = el.tplAdminPanel.content.cloneNode(true);
      el.chatScreen.querySelector('.chat-main').appendChild(clone);
      existingAdminPanel = $('admin-panel');
    }

    if (existingAdminPanel) {
      el.adminPanel = existingAdminPanel;
      
      // スマホの場合、初期表示はアクティブなタブに従う
      if (isMobile()) {
        if (state.activeTab === 'admin') {
          el.adminPanel.classList.remove('hidden');
          el.adminPanel.style.display = 'flex';
          el.adminPanel.classList.add('active-mobile-panel');
        } else {
          el.adminPanel.classList.add('hidden');
          el.adminPanel.style.display = 'none';
          el.adminPanel.classList.remove('active-mobile-panel');
        }
      } else {
        el.adminPanel.classList.remove('hidden');
        el.adminPanel.classList.add('sidebar-admin');
      }

      el.adminRoomList = $('admin-room-list');
      el.btnAdminBroadcast = $('btn-admin-broadcast');
      el.adminBroadcastMsg = $('admin-broadcast-msg');
      
      // 更新ボタンの動的追加（キャッシュが残っている場合や既存DOMの対応）
      el.btnAdminRefresh = $('btn-admin-refresh');
      if (!el.btnAdminRefresh) {
        const header = el.adminPanel.querySelector('.sidebar-header');
        if (header) {
          header.style.display = 'flex';
          header.style.justifyContent = 'flex-start';
          header.style.alignItems = 'center';
          header.style.gap = '8px';
          const title = header.querySelector('.sidebar-title');
          if (title) title.style.margin = '0';
          
          header.insertAdjacentHTML('beforeend', '<button id="btn-admin-refresh" class="btn-refresh" aria-label="手動更新" style="background:transparent; border:none; cursor:pointer; font-size:16px;" title="最新状態に更新">🔄</button>');
          el.btnAdminRefresh = $('btn-admin-refresh');
        }
      }

      if (el.btnAdminBroadcast && !el.btnAdminBroadcast.hasAttribute('data-bound')) {
        el.btnAdminBroadcast.setAttribute('data-bound', 'true');
        el.btnAdminBroadcast.addEventListener('click', () => {
          const content = el.adminBroadcastMsg.value.trim();
          if (!content) return;
          if (!confirm('全ユーザーに対して一斉通知を送信しますか？')) return;
          sendWsMessage({ type: 'admin_broadcast', content: content });
          el.adminBroadcastMsg.value = '';
        });
      }

      if (el.btnAdminRefresh && !el.btnAdminRefresh.hasAttribute('data-bound')) {
        el.btnAdminRefresh.setAttribute('data-bound', 'true');
        el.btnAdminRefresh.addEventListener('click', () => {
          sendWsMessage({ type: 'admin_get_rooms' });
        });
      }

      // 管理者パネル内のルームリセットボタン
      const btnAdminRoomReset = $('btn-admin-room-reset');
      if (btnAdminRoomReset && !btnAdminRoomReset.hasAttribute('data-bound')) {
        btnAdminRoomReset.setAttribute('data-bound', 'true');
        btnAdminRoomReset.addEventListener('click', adminRoomReset);
      }
    }

    // 各 welcome (昇格/降格/同期) ごとに最新の部屋リストを要求する
    sendWsMessage({ type: 'admin_get_rooms' });
    
    // チャットリセットボタンの表示制御
    let roomResetContainer = $('btn-room-reset-container');
    // ボタンが存在しない、またはDOMから切り離されている（Orphan）場合に再注入を試みる
    const isOrphan = roomResetContainer && !roomResetContainer.parentElement;
    if ((!roomResetContainer || isOrphan) && el.sidebarUsers) {
      const div = document.createElement('div');
      div.id = 'btn-room-reset-container';
      div.className = 'admin-controls-room';
      div.innerHTML = `<button class="btn-room-reset">チャットリセット</button>`;
      div.querySelector('button').onclick = adminRoomReset;
      el.sidebarUsers.prepend(div);
      roomResetContainer = div;
    }
    if (roomResetContainer) {
      roomResetContainer.classList.remove('hidden');
      roomResetContainer.style.setProperty('display', 'block', 'important'); // 強制表示を最優先
    }
  } else {
    // 非管理者の場合
    if (el.tabAdmin) {
      el.tabAdmin.classList.add('hidden');
      el.tabAdmin.style.display = 'none';
    }
    if (el.adminPanel) el.adminPanel.classList.add('hidden');
    
    const roomResetContainer = $('btn-room-reset-container');
    if (roomResetContainer) {
      roomResetContainer.classList.add('hidden');
      roomResetContainer.style.display = 'none';
    }

    // 降格時: 管理者用タブを開いていたらチャットに戻す
    if (state.activeTab === 'admin') {
      switchTab('chat');
    }
  }
}

/** ユーザーをキックする */
function adminKickUser(username) {
  if (!confirm(`${username} さんを退場させますか？`)) return;
  sendWsMessage({ type: 'kick', content: username });
}

/** ユーザーの名前を変更する */
function adminRenameUser(oldName) {
  const newName = prompt(`${oldName} さんの新しい名前を入力してください:`, oldName);
  if (!newName || newName === oldName) return;
  sendWsMessage({ type: 'rename_user', username: oldName, content: newName.trim() });
}

/** 部屋内の全データをリセット (チャットリセット) */
function adminRoomReset() {
  if (!confirm('チャット履歴をすべて消去しますか？（この操作は取り消せません）')) return;
  sendWsMessage({ type: 'room_reset' });
}

/** キックされた時の処理 */
/** 強制退出(キック)された時の処理 */
function handleKicked(content) {
  state.isConnected = false;
  state.isLoggedIn = false;
  if (state.ws) state.ws.close();
  
  // セッション情報をクリア
  localStorage.removeItem('gochat_auth');
  
  // キック通知オーバーレイを表示
  if (content) el.kickMessage.textContent = content;
  el.kickOverlay.classList.remove('hidden');
  
  // チャット画面は隠すが、オーバーレイはbody直下なので見える
  el.chatScreen.classList.add('hidden');
}

/** 名前変更イベントの処理 (DOM上の名前を一括置換) */
function handleUserRenamed(oldName, newName) {
  // 自分の名前が変わった場合はstateも更新し、通知を出す
  if (state.username === oldName) {
    state.username = newName;
    el.headerUsername.textContent = newName;
    saveLoginState();
    showToast('管理者によって名前が変更されました', '⚙ システム');
  }

  // チャット内の名前ラベルを更新
  document.querySelectorAll('.msg-meta-name').forEach(el => {
    if (el.textContent.includes(oldName)) {
      el.innerHTML = el.innerHTML.replace(oldName, newName);
    }
  });

  // ユーザーリストの更新（サーバーからまもなく新しいリストが来るが、先行して更新感を出す）
  console.log(`Renaming ${oldName} to ${newName}`);
}

/** チャットリセット受信 */
function handleRoomReset(content) {
  showAlert(content);
  
  // 全メッセージコンテナをクリア
  if (el.messages) el.messages.innerHTML = '';
  if (el.gdMessages) el.gdMessages.innerHTML = '';
  if (el.secretMessages) el.secretMessages.innerHTML = '';
  if (el.interviewerMessages) el.interviewerMessages.innerHTML = '';

  // 共有メモのステートと入力をリセット (GDモードの場合)
  if (state.mode === 'GroupDiscussion') {
    state.gdNote = {
      theme: '', premise: '', issues: '',
      opinions: '', conclusion: '', summary: '',
      editMode: 'secretary'
    };
    [el.noteTheme, el.notePremise, el.noteIssues, el.noteOpinions, el.noteConclusion, el.noteSummary].forEach(field => {
      if (field) field.value = '';
    });
  }
}

/** サーバー全体の部屋リスト描画 */
function renderAdminRoomList(rooms) {
  if (!el.adminRoomList) return;
  el.adminRoomList.innerHTML = '';
  
  if (rooms.length === 0) {
    el.adminRoomList.innerHTML = '<li style="padding:20px; color:var(--text-muted); text-align:center;">アクティブな部屋はありません</li>';
    return;
  }

  // 部屋名はサーバー側でソート（メインルーム固定＋最終更新順）されているため、ここではソートしない

  rooms.forEach(r => {
    const li = document.createElement('li');
    li.className = 'admin-room-item';
    
    // 最新のアクティビティモードに基づいてタグを表示
    let modeTag = '';
    if (r.mode === 'GroupDiscussion') {
      modeTag = '<span style="font-size:10px; padding:2px 4px; border-radius:4px; background:rgba(0,229,255,0.1); color:#00e5ff;">GD練習</span>';
    } else if (r.mode === 'interview') {
      modeTag = '<span style="font-size:10px; padding:2px 4px; border-radius:4px; background:rgba(255,64,129,0.1); color:#ff4081;">面接練習</span>';
    } else if (r.mode === 'chat') {
      modeTag = '<span style="font-size:10px; padding:2px 4px; border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-muted);">通常</span>';
    }

    // 最終更新日時のフォーマット
    let timeStr = '';
    if (r.timestamp && !r.timestamp.startsWith('2000-01-01')) {
      const d = new Date(r.timestamp);
      if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const HH = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        timeStr = `${mm}/${dd} ${HH}:${min}`;
      }
    }

    li.innerHTML = `
      <div class="admin-room-info">
        <div style="display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="admin-room-pass" style="font-weight:bold;">${r.username ? '🔑 ' + escHtml(r.username) : '(メインルーム)'}</span>
            ${modeTag ? `<span style="display:flex; align-items:center; gap:4px; color:var(--text-muted); font-size:10px;">(最新: ${modeTag})</span>` : ''}
          </div>
          <span class="admin-room-count" style="font-size:12px; color:var(--text-muted);">👥 合計 ${r.role} 人 ${timeStr ? `<span style="margin-left:6px; font-size:10px;">(更新: ${timeStr})</span>` : ''}</span>
        </div>
      </div>
      <div class="admin-room-actions">
        <button class="btn-admin-action btn-admin-join" onclick="window.adminJoinRoom('${escHtml(r.username)}', '${r.mode}'); event.stopPropagation();">移動</button>
        <button class="btn-admin-action btn-admin-delete" onclick="window.adminDeleteRoom('${escHtml(r.username)}'); event.stopPropagation();">消去</button>
      </div>
    `;
    el.adminRoomList.appendChild(li);
  });
}

/** 管理者：指定の部屋へ直接移動（入室） */
// 管理者ルームジャンプ機能 (windowスコープへ公開)
window.adminJoinRoom = function(passcode, modeStr) {
  let targetPass = passcode;
  // 送信先のモードが通常（chat）以外の場合は、確実にモードが切り替わるようにプレフィックスを付ける
  if (modeStr && modeStr !== 'chat' && modeStr !== 'undefined') {
    targetPass = modeStr + '|' + targetPass;
  }

  sendWsMessage({
    type: 'admin_join_room',
    passcode: targetPass
  });
  
  // NOTE: 管理者パネルを開いたままにするため、タブの切り替えやパネル非表示処理は行いません。
};

/** 部屋を消去 */
window.adminDeleteRoom = function(passcode) {
  if (!confirm(`部屋 [${passcode}] に関する全モードのデータを完全に消去し、全員をキックしますか？`)) return;
  sendWsMessage({ type: 'admin_delete_room', content: passcode });
};

/** ゴーストモード切替 */
el.btnGhostToggle.addEventListener('click', () => {
  sendWsMessage({ type: 'ghost_toggle' });
  state.isHidden = !state.isHidden;
  el.btnGhostToggle.classList.toggle('active', state.isHidden);
  el.btnGhostToggle.querySelector('span').textContent = state.isHidden ? '隠密ON' : '隠密OFF';
  saveLoginState(); // 状態を即時保存
  
  // 隠密切り替え時に自分自身のリスト表示も即座に更新
  sendWsMessage({ type: 'get_user_list' }); // サーバーから最新リストを取得して再描画
});

/** ユーザーをキック (グローバル) */
window.kickUser = function(target) {
  if (!confirm(`${target} さんを強制退出させますか？`)) return;
  sendWsMessage({ type: 'kick', content: target });
};

  // ユーザーの名前を変更 (グローバル)
window.renameUser = function(target) {
  const newName = prompt(`${target} さんの新しい名前を入力してください:`, target);
  if (!newName || newName === target) return;
  sendWsMessage({ type: 'rename_user', username: target, content: newName });
};


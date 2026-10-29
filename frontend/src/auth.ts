// Login / register / logout for the server library. Only used when a backend is online;
// the static demo build never calls into this module.
import { api, AUTH_CHANGED, AuthUser, getToken, setToken } from './api';
import { $, busy, form, toast } from './ui';

interface AuthState {
  /** False when the server runs with AUTH_REQUIRED=false (or predates accounts). */
  required: boolean;
  user: AuthUser | null;
}

const state: AuthState = { required: false, user: null };
let bar: HTMLElement | undefined;
let onChange: (() => void | Promise<void>) | undefined;

/** True when server documents can be used right now (logged in, or the server needs no login). */
export function canUseServer(): boolean {
  return !state.required || state.user !== null;
}

export function currentUser(): AuthUser | null {
  return state.user;
}

/**
 * Asks the server who we are and renders the login bar above the library.
 * `changed` runs after every login/logout (including a 401 that dropped an expired token).
 */
export async function initAuth(changed: () => void | Promise<void>): Promise<void> {
  if (!onChange) {
    window.addEventListener(AUTH_CHANGED, () => {
      void refresh().then(() => onChange?.());
    });
  }
  onChange = changed;
  await refresh();
}

async function refresh(): Promise<void> {
  try {
    const me = await api.me();
    state.required = me.authRequired;
    state.user = me.user;
    // A stored token the server no longer accepts (expired, secret rotated): drop it. This fires
    // AUTH_CHANGED once more, which re-renders without a token.
    if (!me.user && getToken()) setToken(null);
  } catch {
    state.required = true;
    state.user = null;
  }
  render();
}

function render(): void {
  bar ??= createBar();
  bar.hidden = !state.required;
  const row = bar.firstElementChild as HTMLElement;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const buttons: HTMLButtonElement[] = [];
  if (state.user) {
    const who = document.createElement('div');
    who.className = 'title';
    who.textContent = state.user.email;
    who.title = '로그인한 계정';
    meta.append(who);
    buttons.push(button('로그아웃', logout));
  } else {
    const hint = document.createElement('small');
    hint.textContent = '로그인하면 서버 문서함을 쓸 수 있습니다.';
    meta.append(hint);
    buttons.push(button('로그인', () => login('login')), button('회원가입', () => login('register')));
  }
  row.replaceChildren(meta, ...buttons);
}

function createBar(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'auth-bar';
  el.className = 'library';
  el.style.marginBottom = '6px';
  const row = document.createElement('div');
  row.className = 'row';
  el.append(row);
  $('#library').before(el);
  return el;
}

function button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.onclick = () => void action();
  return b;
}

async function login(mode: 'login' | 'register'): Promise<void> {
  const register = mode === 'register';
  const values = await form(
    register ? '회원가입' : '로그인',
    [
      { name: 'email', label: '이메일', type: 'email', placeholder: 'you@example.com' },
      { name: 'password', label: register ? '비밀번호 (8자 이상)' : '비밀번호', type: 'password' },
    ],
    register ? '서버 문서함은 계정마다 따로 보관됩니다.' : undefined,
  );
  if (!values) return;
  const email = values.email.trim();
  if (!email || !values.password) {
    toast('이메일과 비밀번호를 입력하세요.', 'error');
    return;
  }
  await busy(register ? '회원가입' : '로그인', async () => {
    const session = register ? await api.register(email, values.password) : await api.login(email, values.password);
    setToken(session.token); // fires AUTH_CHANGED → refresh + library reload
    toast(`${session.user.email}(으)로 로그인했습니다.`);
  });
}

function logout(): void {
  setToken(null);
  toast('로그아웃했습니다.');
}

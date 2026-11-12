import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  reload, signOut,
} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import {
  getFirestore, doc, getDocFromServer, onSnapshot, runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js';
import config from './firebase-config.js';

const app = initializeApp(config);
const auth = getAuth(app);
const firestore = getFirestore(app);
const maxBytes = 700000;
const messages = {
  'auth/invalid-credential': 'Check your email address and password.',
  'auth/weak-password': 'Choose a password of at least six characters.',
  'auth/email-already-in-use': 'An account already exists. Sign in or reset your password.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Try again later.',
  'auth/operation-not-allowed': 'Email sign-in is unavailable. Try again later.',
  'auth/network-request-failed': 'Check your internet connection and try again.',
  'permission-denied': 'Access denied. Check the workspace code and the invited email address.',
  'unavailable': 'Firebase is temporarily unreachable. Check your connection.',
};
const workspaceId = /^[\w-]{1,128}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const workspace = id => doc(firestore, 'workspaces', id);
const email = value => value.trim().toLowerCase();

export function installCloud(bridge) {
  const launcher = document.querySelector('#atelier-cloud-open');
  const badge = document.querySelector('#atelier-cloud-state');
  const panel = document.querySelector('#atelier-cloud-panel');
  const forms = Object.fromEntries([...panel.querySelectorAll('form')].map(form => [form.id, form]));
  const controls = Object.fromEntries([...panel.querySelectorAll('button[id]')].map(button => [button.id, button]));
  const status = panel.querySelector('[role=status]');
  const identity = panel.querySelector('#atelier-identity');
  const details = panel.querySelector('#atelier-workspace');
  const code = panel.querySelector('#atelier-code');
  const invite = forms['atelier-invite'].elements.email;
  let user, active, localCopy, disconnect, opening = 0, busy = false, message = '';

  function draftKey(context) {
    return [bridge.key, 'cloud-draft', context.uid, context.id].join('.');
  }

  function setMessage(text) {
    message = text;
    status.textContent = text;
    badge.textContent = active ? text : 'Stored in this browser';
  }

  function describe(error) {
    return messages[error?.code] || error?.userMessage || 'The request could not be completed. Try again.';
  }

  function problem(userMessage) {
    return Object.assign(new Error(userMessage), { userMessage });
  }

  function readDraft(context) {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(context)));
      return Number.isSafeInteger(saved?.base) && typeof saved.payload === 'string' ? saved : null;
    } catch {
      return null;
    }
  }

  function remember(context) {
    try {
      if (context.pending) localStorage.setItem(draftKey(context), JSON.stringify(context.pending));
      else localStorage.removeItem(draftKey(context));
      return true;
    } catch {
      return false;
    }
  }

  function paint() {
    const signedIn = Boolean(user);
    const verified = Boolean(user?.emailVerified);
    forms['atelier-auth'].hidden = signedIn;
    forms['atelier-join'].hidden = !verified || Boolean(active);
    forms['atelier-invite'].hidden = !active?.owner;
    controls['atelier-verify'].hidden = !signedIn || verified;
    controls['atelier-resend'].hidden = !signedIn || verified;
    controls['atelier-signout'].hidden = !signedIn;
    controls['atelier-open-own'].hidden = !verified || Boolean(active);
    controls['atelier-import-own'].hidden = !verified || Boolean(active);
    controls['atelier-leave'].hidden = !active;
    controls['atelier-retry'].hidden = !active?.pending || active.conflict;
    controls['atelier-export-draft'].hidden = !active?.pending;
    controls['atelier-load-cloud'].hidden = !active?.pending;
    details.hidden = !active;
    identity.textContent = signedIn ? user.email : '';
    code.textContent = active?.id || '';
    if (active?.owner && document.activeElement !== invite) invite.value = active.inviteEmail;
    status.textContent = message;
  }

  async function action(work) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    try {
      await work();
    } catch (error) {
      setMessage(describe(error));
    } finally {
      busy = false;
      panel.removeAttribute('aria-busy');
      paint();
    }
  }

  function closeWorkspace() {
    opening++;
    disconnect?.();
    disconnect = undefined;
    if (active) {
      active = undefined;
      bridge.apply(localCopy);
      localCopy = undefined;
    }
    badge.textContent = 'Stored in this browser';
  }

  function refresh(context, snapshot) {
    const entry = snapshot.data();
    if (!entry) throw problem('This workspace is unavailable.');
    if (entry.revision < context.revision) return;
    context.inviteEmail = entry.inviteEmail;
    if (context.pending) {
      if (entry.revision > context.pending.base) {
        if (entry.payload === context.pending.payload) {
          context.pending = null;
          context.conflict = false;
          remember(context);
        } else if (context.writing) {
          return;
        } else {
          context.conflict = true;
          setMessage('Someone changed the workspace. Download your draft before loading the shared version.');
          paint();
          return;
        }
      } else {
        return;
      }
    }
    if (entry.payload !== context.appliedPayload) {
      if (!bridge.canApply()) {
        context.deferred = snapshot;
        setMessage('Shared changes are waiting for your editor to close.');
        return;
      }
      context.deferred = undefined;
      bridge.apply(entry.payload);
      context.appliedPayload = entry.payload;
    }
    context.revision = entry.revision;
    setMessage('Synced with Firebase');
    paint();
  }

  async function openWorkspace(id, { create = false, copy = false } = {}) {
    if (!user?.emailVerified || !workspaceId.test(id)) throw problem('Enter a valid workspace code.');
    const current = user;
    const ticket = ++opening;
    const ref = workspace(id);
    if (create) {
      const payload = copy ? bridge.read() : bridge.empty();
      checkSize(payload);
      const created = await runTransaction(firestore, async tx => {
        const prior = await tx.get(ref);
        if (prior.exists()) return false;
        tx.set(ref, { payload, inviteEmail: '', revision: 0 });
        return true;
      });
      if (copy && !created) throw problem('A workspace already exists. Open it and use Import JSON if you want to restore a backup.');
    }
    const snapshot = await getDocFromServer(ref);
    if (!snapshot.exists()) throw problem('This workspace does not exist.');
    if (ticket !== opening || user !== current) return;
    const data = snapshot.data();
    const context = {
      id, ref, uid: current.uid, owner: id === current.uid, inviteEmail: data.inviteEmail,
      revision: data.revision, pending: null, writing: false, conflict: false,
    };
    localCopy = bridge.read();
    active = context;
    context.pending = readDraft(context);
    if (context.pending && context.pending.payload === data.payload) {
      context.pending = null;
      remember(context);
    }
    try {
      if (context.pending) {
        bridge.apply(context.pending.payload);
        context.appliedPayload = context.pending.payload;
        context.conflict = context.pending.base !== data.revision;
        setMessage(context.conflict
          ? 'A local draft differs from the shared version. Download it before loading the shared version.'
          : 'A local draft is ready to sync.');
      } else refresh(context, snapshot);
    } catch (error) {
      closeWorkspace();
      throw error;
    }
    disconnect = onSnapshot(ref, { includeMetadataChanges: true }, next => {
      if (active !== context || next.metadata.fromCache || next.metadata.hasPendingWrites) return;
      try {
        refresh(context, next);
      } catch (error) {
        closeWorkspace();
        setMessage(describe(error));
        paint();
      }
    }, error => {
      if (active !== context) return;
      if (error.code === 'permission-denied' || !context.pending) closeWorkspace();
      setMessage(describe(error));
      paint();
    });
    paint();
  }

  function checkSize(payload) {
    if (new TextEncoder().encode(payload).length > maxBytes) {
      throw problem('This workspace is too large to sync. Download a JSON backup.');
    }
  }

  async function flush(context) {
    if (!context || context.writing || context.conflict || !context.pending) return;
    context.writing = true;
    try {
      while (active === context && context.pending) {
        const draft = context.pending;
        checkSize(draft.payload);
        const revision = await runTransaction(firestore, async tx => {
          const snapshot = await tx.get(context.ref);
          const entry = snapshot.data();
          if (!entry) throw problem('This workspace is unavailable.');
          if (entry.revision !== draft.base) {
            context.conflict = true;
            throw problem('Someone changed the workspace. Download your draft before loading the shared version.');
          }
          tx.update(context.ref, { payload: draft.payload, revision: draft.base + 1 });
          return draft.base + 1;
        });
        context.revision = revision;
        context.appliedPayload = draft.payload;
        if (context.pending === draft) context.pending = null;
        else if (context.pending) context.pending.base = revision;
        remember(context);
      }
      if (active === context) {
        setMessage('Synced with Firebase');
        void getDocFromServer(context.ref).then(snapshot => {
          if (active === context) refresh(context, snapshot);
        }).catch(() => {});
      }
    } catch (error) {
      if (active === context) setMessage(describe(error));
    } finally {
      context.writing = false;
      if (active === context) paint();
    }
  }

  function save(payload) {
    if (!active) return null;
    active.pending = { base: active.pending?.base ?? active.revision, payload };
    const saved = remember(active);
    setMessage(active.conflict ? 'Workspace conflict. Download your draft.' : 'Syncing with Firebase…');
    paint();
    void flush(active);
    return saved;
  }

  function downloadDraft() {
    if (!active?.pending) return;
    const url = URL.createObjectURL(new Blob([active.pending.payload], { type: 'application/json' }));
    active.backedUp = active.pending;
    const link = document.createElement('a');
    link.href = url;
    link.download = bridge.key + '-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  forms['atelier-auth'].addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const method = event.submitter?.value;
    const address = email(form.elements.email.value);
    const password = form.elements.password.value;
    form.elements.password.value = '';
    void action(async () => {
      if (!emailPattern.test(address)) throw problem('Enter a valid email address.');
      if (method === 'reset') {
        try {
          await sendPasswordResetEmail(auth, address);
        } catch (error) {
          if (error.code !== 'auth/user-not-found') throw error;
        }
        setMessage('If an account exists, a password reset email has been sent.');
      } else if (method === 'register') {
        const result = await createUserWithEmailAndPassword(auth, address, password);
        await sendEmailVerification(result.user);
        setMessage('Check your inbox for the verification email.');
      } else {
        await signInWithEmailAndPassword(auth, address, password);
      }
    });
  });
  forms['atelier-join'].addEventListener('submit', event => {
    event.preventDefault();
    const id = event.currentTarget.elements.code.value.trim();
    void action(() => openWorkspace(id));
  });
  forms['atelier-invite'].addEventListener('submit', event => {
    event.preventDefault();
    const address = event.submitter?.value === 'revoke' ? '' : email(invite.value);
    const context = active;
    void action(async () => {
      if (!context?.owner || context.pending) throw problem('Finish syncing before changing the invite.');
      if (address && (!emailPattern.test(address) || address === user.email)) throw problem('Enter the other person’s email address.');
      await runTransaction(firestore, async tx => {
        const entry = (await tx.get(context.ref)).data();
        tx.update(context.ref, { inviteEmail: address, revision: entry.revision + 1 });
      });
      if (active !== context) return;
      context.inviteEmail = address;
      invite.value = address;
      setMessage(address ? 'Invite saved. Send the workspace code to that person.' : 'Shared access removed.');
    });
  });
  controls['atelier-open-own'].onclick = () => action(() => openWorkspace(user.uid, { create: true }));
  controls['atelier-import-own'].onclick = () => action(() => openWorkspace(user.uid, { create: true, copy: true }));
  controls['atelier-resend'].onclick = () => action(async () => {
    await sendEmailVerification(user);
    setMessage('Verification email sent.');
  });
  controls['atelier-verify'].onclick = () => action(async () => {
    await reload(user);
    await user.getIdToken(true);
    setMessage(user.emailVerified ? 'Email verified. Open or join a workspace.' : 'Email verification is still pending.');
  });
  controls['atelier-signout'].onclick = () => action(async () => {
    if (active?.pending && active.backedUp !== active.pending) throw problem('Sync or download your draft before signing out.');
    await signOut(auth);
  });
  controls['atelier-leave'].onclick = () => action(async () => {
    if (active?.pending && active.backedUp !== active.pending) throw problem('Sync or download your draft before leaving.');
    closeWorkspace();
    setMessage('You are viewing your local planner.');
  });
  controls['atelier-retry'].onclick = () => flush(active);
  controls['atelier-export-draft'].onclick = downloadDraft;
  controls['atelier-load-cloud'].onclick = () => action(async () => {
    const context = active;
    if (!context?.pending || context.writing || !window.confirm('Replace the unsynced draft with the shared version?')) return;
    const snapshot = await getDocFromServer(context.ref);
    if (active !== context) return;
    context.pending = null;
    context.conflict = false;
    remember(context);
    refresh(context, snapshot);
  });
  onAuthStateChanged(auth, account => {
    if (active && active.uid !== account?.uid) closeWorkspace();
    user = account;
    if (!active) setMessage(account
      ? account.emailVerified ? 'Open your workspace or join one by code.' : 'Verify your email to enable shared workspaces.'
      : 'Sign in to sync or share this planner.');
    paint();
  });
  function refreshDeferred() {
    const context = active;
    if (context?.deferred && bridge.canApply()) {
      try {
        refresh(context, context.deferred);
      } catch (error) {
        closeWorkspace();
        setMessage(describe(error));
        paint();
      }
    }
  }
  document.addEventListener('close', refreshDeferred, true);
  window.addEventListener('online', () => void flush(active));
  launcher.textContent = 'Account & sync';
  setMessage('Sign in to sync or share this planner.');
  paint();
  return { save, isActive: () => Boolean(active) };
}

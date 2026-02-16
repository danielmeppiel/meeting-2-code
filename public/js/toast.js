/**
 * Toast notification system.
 * Displays dismissible notifications with auto-dismiss for non-error types.
 * @module toast
 */

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'error'|'warning'|'info'|'success'} [type='error']
 */
export function showToast(message, type = 'error') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-message';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => toast.remove();
    toast.appendChild(closeBtn);

    document.body.appendChild(toast);

    // Errors stay until dismissed; others auto-dismiss
    if (type !== 'error') {
        setTimeout(() => toast.remove(), 6000);
    }
}

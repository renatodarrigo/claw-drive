// claw-drive website — clipboard copy + nav active state + footer year

document.addEventListener('DOMContentLoaded', () => {
  // Footer year
  const yearEl = document.querySelector('[data-year]');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Active-nav highlight based on filename
  const path = location.pathname.split('/').filter(Boolean).pop() || 'index.html';
  const currentPage = path.endsWith('.html') ? path : 'index.html';
  document.querySelectorAll('nav a[data-page]').forEach(a => {
    if (a.dataset.page === currentPage) a.classList.add('active');
  });

  // Copy button on every <pre><code>
  document.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code') || pre;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1200);
      } catch (err) {
        btn.textContent = 'Error';
      }
    });
    pre.appendChild(btn);
  });
});

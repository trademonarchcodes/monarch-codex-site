'use strict';

const MEMBER_NAV_ITEMS = Object.freeze([
  Object.freeze({ href: '/dashboard', label: 'Overview', icon: '◫', locked: false }),
  Object.freeze({ href: '/sovereign-desk', label: 'Sovereign Desk', icon: '♛', locked: false }),
  Object.freeze({ href: '/tools', label: 'Tools', icon: '⚒', locked: false }),
  Object.freeze({ href: '/market-news.html', label: 'Feeds', icon: '◉', locked: false }),
  Object.freeze({ href: '/market-movers.html', label: 'Live Markets', icon: '↗', locked: false }),
  Object.freeze({ href: '/profile', label: 'Profile', icon: '◎', locked: false }),
  Object.freeze({ href: '/roles', label: 'My Roles', icon: '♜', locked: false }),
  Object.freeze({ href: '/kyc', label: 'Verification', icon: '◇', locked: false }),
  Object.freeze({ href: '/deposit', label: 'Deposit', icon: '＋', locked: false }),
  Object.freeze({ href: '/withdraw', label: 'Withdraw', icon: '↗', locked: false }),
  Object.freeze({ href: '/transactions', label: 'Transactions', icon: '↔', locked: false }),
  Object.freeze({ href: '/wallet-transfer', label: 'Wallet Transfer', icon: '⇄', locked: false }),
  Object.freeze({ href: '/investments', label: 'Investments', icon: '◆', locked: false }),
  Object.freeze({ href: '/referrals', label: 'Referrals', icon: '♧', locked: false }),
  Object.freeze({ href: '/online-cooperative', label: 'Online Cooperative', icon: '♙', locked: false }),
  Object.freeze({ href: '/community', label: 'Community', icon: '◉', locked: false }),
  Object.freeze({ href: '/feedback.html', label: 'Feedback & Suggestions', icon: '✎', locked: false }),
  Object.freeze({ href: '/help-support.html', label: 'Help & Support', icon: '?', locked: false }),
  Object.freeze({ href: '/social-links', label: 'Social Links', icon: '↗', locked: false })
]);

function renderMemberNavigation(activePath, kycApproved = true) {
  // Keep navigation visually open; protected server routes still enforce KYC approval.
  return MEMBER_NAV_ITEMS.map(({ href, label, icon }) => {
    const locked = false;
    const active = href === activePath ? ' aria-current="page"' : '';
    const lockAttributes = locked ? ' data-kyc-locked="true" aria-disabled="true" title="Complete KYC verification to unlock"' : '';
    const originalHref = locked ? ' data-member-href="' + href + '"' : '';
    const lockBadge = locked
      ? '<span class="member-kyc-lock" aria-label="Locked until KYC is approved" title="Locked until KYC is approved">🔒</span>'
      : '';
    const badgeKey = href === '/community' ? 'community'
      : ['/deposit', '/withdraw', '/transactions'].includes(href) ? 'wallet'
      : href === '/investments' ? 'invest'
      : ['/profile', '/roles', '/kyc'].includes(href) ? 'profile'
      : href === '/sovereign-desk' ? 'sovereign' : '';
    const countBadge = badgeKey ? '<span class="member-nav-count" data-member-nav-badge="' + badgeKey + '" hidden></span>' : '';
    const special = href === '/sovereign-desk' ? ' member-nav-sovereign' : '';
    const specialStyle = href === '/sovereign-desk' ? ' style="border:1px solid #6d592d;background:linear-gradient(100deg,#e5c46a1f,#e5c46a08);color:#f3d47a"' : '';
    const target = locked ? '/kyc?required=approval' : href;
    return '<a class="member-nav-link' + special + (locked ? ' is-kyc-locked' : '') + '" href="' + target + '"' + specialStyle + active + lockAttributes + originalHref + '>'
      + '<span class="member-nav-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="nav-text member-nav-label">' + label + '</span>' +
      countBadge + lockBadge + '</a>';
  }).join('');
}

module.exports = { MEMBER_NAV_ITEMS, renderMemberNavigation };

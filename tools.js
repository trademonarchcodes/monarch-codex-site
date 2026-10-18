'use strict';

const express = require('express');

module.exports = function createToolsRouter({ pool, requireAuth, requireAdmin, csrfCheck, csrfField, memberPage, adminControlPage, getMemberForPage, esc }) {
  const router = express.Router();
  let schemaReady;
  const ensureSchema = async (_req, _res, next) => {
    try {
      if (!schemaReady) schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS member_tools (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(120) NOT NULL,
        description VARCHAR(500) NOT NULL DEFAULT '',
        url VARCHAR(2048) NOT NULL,
        category VARCHAR(80) NOT NULL DEFAULT 'Class tools',
        icon VARCHAR(24) NOT NULL DEFAULT '↗',
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_member_tools_active_order (is_active, sort_order, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).then(async () => {
        const [existing] = await pool.execute('SELECT COUNT(*) AS total FROM member_tools');
        if (Number(existing[0] && existing[0].total) === 0) {
          await pool.execute('INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active) VALUES (?,?,?,?,?,?,1),(?,?,?,?,?,?,1),(?,?,?,?,?,?,1),(?,?,?,?,?,?,1)', [
            'Bybit', 'Exchange app used for selected class demonstrations. Availability and features vary by region.', 'https://www.bybit.com/invite?ref=ZDWQB3B&medium=referral&utm_campaign=evergreen&share_to=post', 'Trading & exchanges', '↗', 10,
            'WEEX', 'Exchange app used for selected class demonstrations. Availability and features vary by region.', 'https://weex.com/register?vipCode=h3wh', 'Trading & exchanges', '↗', 20,
            'Google Flow', 'AI filmmaking and creative workflow tool for class projects.', 'https://labs.google/fx/tools/flow/', 'AI & productivity', '✦', 30,
            'TradingView', 'Charts and market-analysis workspace for practice and demonstrations.', 'https://www.tradingview.com/pricing/?share_your_love=TradeMonarch&mobileapp=true', 'Charts & analysis', '⌁', 40
          ]);
        }
      });
      await schemaReady;
      await pool.execute(
        "UPDATE member_tools SET url=CASE title WHEN 'Bybit' THEN ? WHEN 'WEEX' THEN ? WHEN 'Google Flow' THEN ? WHEN 'TradingView' THEN ? ELSE url END WHERE (title='Bybit' AND url='https://www.bybit.com/') OR (title='WEEX' AND url='https://www.weex.com/') OR (title='Google Flow' AND url='https://labs.google/fx/tools/flow') OR (title='TradingView' AND url='https://www.tradingview.com/')",
        ['https://www.bybit.com/invite?ref=ZDWQB3B&medium=referral&utm_campaign=evergreen&share_to=post', 'https://weex.com/register?vipCode=h3wh', 'https://labs.google/fx/tools/flow/', 'https://www.tradingview.com/pricing/?share_your_love=TradeMonarch&mobileapp=true']
      );
      next();
    } catch (error) { schemaReady = null; next(error); }
  };
  router.use(ensureSchema);

  const escape = value => esc(String(value == null ? '' : value));
  const safeUrl = value => {
    try {
      const parsed = new URL(String(value || '').trim());
      return parsed.protocol === 'https:' ? parsed.toString() : '';
    } catch (_) { return ''; }
  };
  const field = (label, name, value, type = 'text', required = true, extra = '') => {
    const attrs = ' name="' + name + '"' + (required ? ' required' : '') + ' ' + extra;
    return '<label class="tool-form-field"><span>' + label + '</span>' +
      (type === 'textarea'
        ? '<textarea' + attrs + '>' + escape(value) + '</textarea>'
        : '<input type="' + type + '"' + attrs + ' value="' + escape(value) + '">') + '</label>';
  };

  router.get('/tools', requireAuth, async (req, res, next) => {
    try {
      const member = await getMemberForPage(req, res);
      if (!member) return;
      const [rows] = await pool.execute('SELECT id,title,description,url,category,icon FROM member_tools WHERE is_active=1 ORDER BY sort_order ASC,id ASC');
      const grouped = new Map();
      rows.forEach(tool => {
        const category = tool.category || 'Class tools';
        if (!grouped.has(category)) grouped.set(category, []);
        grouped.get(category).push(tool);
      });
      const cards = rows.length ? Array.from(grouped.entries()).map(([category, tools]) =>
        '<section class="tools-category"><div class="tools-category-heading"><div><span class="tools-category-kicker">RESOURCE COLLECTION</span><h2>' + escape(category) + '</h2></div><span class="tools-category-count">' + tools.length + ' resources</span></div><div class="tools-grid">' +
        tools.map(tool => '<article class="tool-card"><div class="tool-card-top"><span class="tool-card-icon" aria-hidden="true">' + escape(tool.icon || '↗') + '</span><span class="tool-card-label">CLASS RESOURCE</span></div><h3>' + escape(tool.title) + '</h3><p>' + escape(tool.description || 'A resource selected for Monarch Codex learning sessions.') + '</p><a class="tool-open" href="' + escape(safeUrl(tool.url)) + '" target="_self" rel="noopener noreferrer">Open resource <span aria-hidden="true">↗</span></a></article>').join('') +
        '</div></section>').join('') : '<div class="tools-empty"><span class="tools-empty-icon">✦</span><h2>Your learning toolkit is being prepared</h2><p>Approved class resources will appear here when the team adds them.</p></div>';
      const content = '<style>' + styles + '</style><main class="tools-page"><header class="tools-hero"><div><span class="tools-eyebrow">MONARCH CODEX · LEARNING HUB</span><h1>Your <em>Tools</em></h1><p>Everything you need for our classes, practice sessions and Monarch Codex learning journey — gathered in one place.</p></div><div class="tools-hero-mark" aria-hidden="true">⚒</div></header><div class="tools-notice"><span>✦</span><p><strong>Learn. Practice. Build.</strong> Open a resource from the list below. Some tools may require you to create a separate account or install their app.</p></div>' + cards + '<p class="tools-footnote">Only use official app stores and verified websites. Trading involves risk; these tools are for learning and access, not a promise of profit.</p></main>';
      return res.send(memberPage('Tools & Resources', '/tools', member, content, req));
    } catch (error) { next(error); }
  });

  router.get('/admin/tools', requireAdmin, async (req, res, next) => {
    try {
      const [rows] = await pool.execute('SELECT id,title,description,url,category,icon,sort_order,is_active FROM member_tools ORDER BY is_active DESC,sort_order ASC,id DESC');
      const listing = rows.length ? '<div class="at-table-wrap"><table class="at-table"><thead><tr><th>Resource</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + rows.map(tool =>
        '<tr><td><strong>' + escape(tool.title) + '</strong><small>' + escape(tool.url) + '</small></td><td>' + escape(tool.category) + '</td><td><span class="at-status ' + (Number(tool.is_active) ? 'is-live' : 'is-hidden') + '">' + (Number(tool.is_active) ? 'Visible to members' : 'Hidden') + '</span></td><td><form method="post" action="/admin/tools/' + Number(tool.id) + '/toggle">' + csrfField(req) + '<button class="at-btn at-secondary" type="submit">' + (Number(tool.is_active) ? 'Hide' : 'Restore') + '</button></form> <form method="post" action="/admin/tools/' + Number(tool.id) + '/delete" onsubmit="return confirm(&quot;Permanently remove this resource?&quot;)">' + csrfField(req) + '<button class="at-btn at-danger" type="submit">Remove</button></form></td></tr>'
      ).join('') + '</tbody></table></div>' : '<div class="at-empty"><h2>No resources yet</h2><p>Add the first class tool using the form.</p></div>';
      const content = '<style>' + adminStyles + '</style><main class="at-page"><header class="at-hero"><div><span>MEMBER LEARNING HUB</span><h1>Tools & Resources</h1><p>Add, organize, hide or remove the apps and websites used during Monarch Codex classes.</p></div></header><section class="at-panel"><h2>Add a resource</h2><p class="at-help">Use the official HTTPS website or app-store link. Only resources you add as active will appear in member dashboards.</p><form class="at-form" method="post" action="/admin/tools" autocomplete="off">' + csrfField(req) +
        field('Resource name', 'title', '') + field('Official HTTPS link', 'url', '', 'url', true, 'placeholder="https://example.com"') +
        field('Category', 'category', 'Trading & exchanges') + field('Short description', 'description', '', 'textarea', false, 'maxlength="500" placeholder="What members will use this for"') +
        field('Display icon', 'icon', '↗', 'text', true, 'maxlength="24"') + field('Display order (lower appears first)', 'sort_order', '0', 'number', true, 'min="0" max="9999"') +
        '<button class="at-btn at-primary" type="submit">＋ Add to member tools</button></form></section><section class="at-panel"><div class="at-panel-heading"><div><h2>Published resources</h2><p>Changes here control what members see in their Tools section.</p></div><span class="at-count">' + rows.length + ' total</span></div>' + listing + '</section></main>';
      return res.send(adminControlPage('Tools & Resources', '/admin/tools', content, req));
    } catch (error) { next(error); }
  });

  router.post('/admin/tools', requireAdmin, csrfCheck, async (req, res, next) => {
    try {
      const title = String(req.body.title || '').trim().slice(0, 120);
      const url = safeUrl(req.body.url);
      const category = String(req.body.category || 'Class tools').trim().slice(0, 80) || 'Class tools';
      const description = String(req.body.description || '').trim().slice(0, 500);
      const icon = String(req.body.icon || '↗').trim().slice(0, 24) || '↗';
      const order = Number.parseInt(req.body.sort_order, 10);
      if (!title || !url || !Number.isInteger(order) || order < 0 || order > 9999) {
        return res.status(400).send(adminControlPage('Invalid resource', '/admin/tools', '<div class="at-page"><section class="at-panel"><h1>Resource not added</h1><p>Enter a name, a valid HTTPS link and a display order between 0 and 9999.</p><a class="at-btn at-primary" href="/admin/tools">Back to Tools</a></section></div>', req));
      }
      await pool.execute('INSERT INTO member_tools (title,description,url,category,icon,sort_order,is_active) VALUES (?,?,?,?,?,?,1)', [title, description, url, category, icon, order]);
      return res.redirect('/admin/tools?added=1');
    } catch (error) { next(error); }
  });

  router.post('/admin/tools/:id/toggle', requireAdmin, csrfCheck, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send('Invalid resource ID.');
      await pool.execute('UPDATE member_tools SET is_active=IF(is_active=1,0,1) WHERE id=?', [id]);
      return res.redirect('/admin/tools');
    } catch (error) { next(error); }
  });

  router.post('/admin/tools/:id/delete', requireAdmin, csrfCheck, async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).send('Invalid resource ID.');
      await pool.execute('DELETE FROM member_tools WHERE id=?', [id]);
      return res.redirect('/admin/tools');
    } catch (error) { next(error); }
  });

  return router;
};

const styles = `
.tools-page{max-width:1180px;margin:0 auto;padding:clamp(18px,3vw,34px);color:#f5f1e6}
.tools-hero{display:flex;justify-content:space-between;align-items:center;gap:22px;padding:clamp(24px,4vw,42px);border:1px solid #514323;border-radius:26px;background:radial-gradient(ellipse at 90% 10%,#e5c46a20,transparent 40%),linear-gradient(130deg,#1b1a17,#101012 70%);box-shadow:0 18px 44px #0002}
.tools-eyebrow,.tools-category-kicker{font-size:.7rem;font-weight:900;letter-spacing:.16em;color:#dfbd62}
.tools-hero h1{font-size:clamp(2.2rem,5vw,3.8rem);letter-spacing:-.055em;margin:12px 0;line-height:1.02;color:#faf6e9}
.tools-hero h1 em{font-style:normal;color:#e5c46a}
.tools-hero p{max-width:680px;color:#c8c1b0;line-height:1.75;margin:0}
.tools-hero-mark{flex:0 0 88px;width:88px;height:88px;display:grid;place-items:center;border:1px solid #6a5628;border-radius:26px;background:#e5c46a12;color:#e5c46a;font-size:2.6rem}
.tools-notice{display:flex;gap:13px;align-items:flex-start;margin:20px 0 30px;padding:17px 19px;border:1px solid #393326;border-radius:16px;background:#171614}
.tools-notice>span{color:#e5c46a;font-size:1.2rem}.tools-notice p{margin:0;color:#c9c2b2;line-height:1.65}.tools-notice strong{color:#f5dfa0}
.tools-category{margin:30px 0}.tools-category-heading{display:flex;justify-content:space-between;align-items:end;gap:12px;margin-bottom:14px}.tools-category-heading h2{margin:6px 0 0;font-size:1.3rem;color:#f4e8c4}.tools-category-count{color:#989180;font-size:.78rem}
.tools-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}
.tool-card{min-width:0;padding:20px;border:1px solid #34312a;border-radius:20px;background:linear-gradient(145deg,#19191a,#101012);transition:border-color .18s,transform .18s}
.tool-card:hover{border-color:#8a7135;transform:translateY(-2px)}.tool-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.tool-card-icon{width:44px;height:44px;display:grid;place-items:center;border:1px solid #5a4925;border-radius:14px;background:#e5c46a12;color:#f0d27b;font-size:1.3rem}
.tool-card-label{font-size:.62rem;font-weight:850;letter-spacing:.12em;color:#8f897a}
.tool-card h3{margin:19px 0 8px;font-size:1.12rem;color:#fff6db}.tool-card p{min-height:52px;margin:0 0 19px;color:#bdb7a9;font-size:.91rem;line-height:1.65;overflow-wrap:anywhere}
.tool-open{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:linear-gradient(110deg,#f0d783,#d2ad4b);color:#17140b;text-decoration:none;font-weight:900}.tool-open span{font-size:1.15rem}
.tools-empty{padding:42px 20px;text-align:center;border:1px dashed #5a4a28;border-radius:22px;background:#171614}.tools-empty-icon{color:#e5c46a;font-size:2rem}.tools-empty h2{margin:12px 0;color:#f4dfa0}.tools-empty p,.tools-footnote{color:#a9a394;line-height:1.7}.tools-footnote{font-size:.8rem;margin:26px 0 0}
@media(max-width:850px){.tools-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.tools-page{padding:14px}.tools-hero{padding:23px 20px;border-radius:20px}.tools-hero-mark{flex-basis:58px;width:58px;height:58px;border-radius:18px;font-size:1.8rem}.tools-grid{grid-template-columns:1fr}.tool-card{padding:18px}.tool-card p{min-height:0}}
`;

const adminStyles = `
.at-page{max-width:1250px;margin:0 auto;padding:clamp(14px,3vw,30px);color:#f5f1e6}.at-hero{padding:28px;border:1px solid #514323;border-radius:22px;background:radial-gradient(ellipse at 90% 0,#e5c46a1d,transparent 45%),#151516}.at-hero>div>span{color:#dfbd62;font-size:.68rem;font-weight:900;letter-spacing:.16em}.at-hero h1{margin:10px 0;font-size:clamp(1.8rem,4vw,2.8rem);color:#f9e9b5}.at-hero p,.at-help,.at-panel-heading p{color:#bdb7a9;line-height:1.6}.at-panel{margin-top:20px;padding:clamp(18px,3vw,26px);border:1px solid #36332c;border-radius:20px;background:#141416}.at-panel h2{margin:0;color:#f4dfa0;font-size:1.25rem}.at-help{margin:8px 0 20px}.at-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.tool-form-field{display:grid;gap:8px;min-width:0;color:#d9d2c2;font-size:.85rem;font-weight:750}.tool-form-field input,.tool-form-field textarea{width:100%;box-sizing:border-box;padding:13px;border:1px solid #454033;border-radius:11px;background:#0c0c0e;color:#fff;font:inherit}.tool-form-field textarea{min-height:100px;resize:vertical}.tool-form-field:has(textarea){grid-column:1/-1}.tool-form-field input:focus,.tool-form-field textarea:focus{outline:2px solid #b99842;outline-offset:1px}.at-btn{display:inline-flex;justify-content:center;align-items:center;gap:7px;padding:11px 15px;border:0;border-radius:11px;font:inherit;font-size:.85rem;font-weight:850;text-decoration:none;cursor:pointer}.at-primary{background:linear-gradient(110deg,#f0d783,#d2ad4b);color:#17140b}.at-secondary{background:#26231c;color:#f3dfa0;border:1px solid #5b4b2b}.at-danger{background:#351a19;color:#ffb3a8;border:1px solid #713c35}.at-form>.at-btn{justify-self:start;grid-column:1/-1}.at-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.at-panel-heading p{margin:7px 0 0}.at-count{padding:7px 10px;border:1px solid #544526;border-radius:999px;color:#e5c46a;font-size:.78rem;font-weight:800}.at-table-wrap{overflow-x:auto;margin-top:18px}.at-table{width:100%;border-collapse:collapse;min-width:640px}.at-table th,.at-table td{padding:13px 12px;border-bottom:1px solid #302d27;text-align:left;vertical-align:middle}.at-table th{color:#9c9687;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em}.at-table td{color:#d9d2c2;font-size:.86rem}.at-table td small{display:block;max-width:300px;margin-top:5px;color:#898476;overflow-wrap:anywhere}.at-table td form{display:inline-block;margin:3px}.at-status{display:inline-block;padding:6px 9px;border-radius:999px;font-size:.7rem;font-weight:850}.at-status.is-live{background:#153326;color:#8ce0ae}.at-status.is-hidden{background:#302b20;color:#d6c08a}.at-empty{padding:26px 0;color:#bdb7a9}.at-empty h2{margin-bottom:8px}@media(max-width:650px){.at-form{grid-template-columns:1fr}.at-form>.at-btn{grid-column:auto}.at-hero{padding:22px}.at-panel{padding:16px}}
`;

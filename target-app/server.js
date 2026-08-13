// Meridian Federal Credit Union — "Teller Console 2.4" (demo target app)
//
// A deliberately LEGACY surface: frameset layout, nested table markup, no test
// IDs, generic class names, server-rendered forms. It is the proxy target for
// the automation system — a stand-in for a real core-banking screen.
//
// It also produces the RUNTIME error states the assignment cares about:
//   - "no member found"            (expected business outcome)
//   - permission denial            (expected business outcome)
//   - session expiry               (recoverable: re-login)
//   - maintenance interstitial     (recoverable: dismiss and continue)
//   - transient slowness           (recoverable: wait/retry)   -> ?slow=1
//   - hard server error            (hard failure)              -> ?break=1
//
// Query flags for fault injection (used by evidence replays):
//   ?slow=1   next /main/results responds after 6s
//   ?break=1  next /main/results responds 500
//   POST /admin/expire-sessions  kills all sessions (forces re-login)
//
// Plain Node, zero dependencies. `npm run target-app` -> http://127.0.0.1:4173

import http from "node:http";
import crypto from "node:crypto";

const PORT = 4173;

// ---------------------------------------------------------------- demo data
const MEMBERS = {
  12345: {
    name: "Dana Whitfield",
    since: "2011-04-18",
    accounts: [
      ["Savings — Regular Share", "S-0001", "$4,982.17"],
      ["Checking — Everyday", "C-0002", "$1,240.55"],
      ["Certificate 12mo", "T-0003", "$10,000.00"],
    ],
  },
  22222: {
    name: "Rob Alvarez",
    since: "2018-09-02",
    accounts: [["Savings — Regular Share", "S-0001", "$812.03"]],
  },
  66600: { name: "RESTRICTED", restricted: true },
};

const DEMO_USER = "teller1";
const DEMO_PASS = "demo-pass"; // demo creds; also documented in README

// ------------------------------------------------------------ session store
const sessions = new Map(); // sid -> { user, hits }
let interstitialArmed = true; // first post-login navigation shows a notice
let slowNext = false;
let breakNext = false;
let expireBudget = null; // ?expire_after=N -> session dies N auth'd requests later

function html(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

// `variant: "standalone"` vertically centres the card (sign-in, session
// notices — pages shown outside the frameset). Framed content stays
// top-aligned. Only a <body> class: no id/test hook, and nothing the
// automation locates by.
const page = (title, body, variant = "framed") => `<html>
<head><title>${title}</title>
<style>
 /* Presentation only. The MARKUP stays deliberately hostile — frameset,
    table layout, no test IDs, no semantic elements, presentational class
    names — because that is the surface this project exists to automate.
    This stylesheet only makes it look like a maintained enterprise app
    rather than a broken one; the DOM the automation sees is unchanged. */
 /* Centred column layout. Flex on <body> rather than a wrapper element,
    because adding a wrapper would change the DOM the automation targets. */
 body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 13px;
        color:#1f2733; background:#eef1f5; margin:0; padding:32px 16px;
        box-sizing:border-box; min-height:100vh;
        display:flex; flex-direction:column; align-items:center; }
 /* the "safe" keyword keeps tall content from overflowing past the top */
 body.standalone { justify-content:center; justify-content:safe center; }
 table.box { border:1px solid #c3ccd8; background:#fff; border-radius:4px;
             border-collapse:separate; border-spacing:0; overflow:hidden;
             box-shadow:0 1px 3px rgba(20,35,60,.10); margin-bottom:16px; }
 td.hdr { background:linear-gradient(#274b7d,#1e3c66); color:#fff; font-weight:600;
          letter-spacing:.02em; padding:8px 12px; font-size:13px;
          border-bottom:1px solid #16304f; }
 td.lbl { padding:8px 12px; color:#4a5768; white-space:nowrap;
          border-bottom:1px solid #eef1f5; }
 td.val { padding:8px 12px; color:#1f2733; border-bottom:1px solid #eef1f5; }
 input[type=text], input[type=password] {
   font-family:inherit; font-size:13px; padding:5px 8px; color:#1f2733;
   border:1px solid #b6c2d2; border-radius:3px; background:#fff; }
 input[type=text]:focus, input[type=password]:focus {
   outline:none; border-color:#3c6fb4; box-shadow:0 0 0 3px rgba(60,111,180,.18); }
 input[type=submit] {
   font-family:inherit; font-size:13px; font-weight:600; padding:6px 16px;
   color:#fff; background:linear-gradient(#3d72b8,#2f5c9a); cursor:pointer;
   border:1px solid #27508a; border-radius:3px; }
 input[type=submit]:hover { background:linear-gradient(#4880c8,#356aad); }
 input[type=submit]:active { background:#2b5591; }
 .err { color:#a3261d; font-weight:600; }
 a { color:#22548f; text-decoration:none; }
 a:hover { text-decoration:underline; }
 .foot { color:#8894a5; margin-top:18px; font-size:11px;
         border-top:1px solid #dde3ec; padding-top:8px; }
 /* nav frame: turn the bare link list into a sidebar */
 td.val a, td a { display:inline-block; padding:2px 0; }
 /* money / account columns read as a financial grid: aligned, tabular
    figures. Targeted by attribute, not by any id the automation could use. */
 td[align=right] { font-variant-numeric:tabular-nums; font-feature-settings:"tnum";
                   white-space:nowrap; }
 /* zebra striping for multi-row data tables */
 tr:nth-of-type(even) td.val { background:#fafbfd; }
</style></head>
<body class="${variant}">${body}<div class="foot">Teller Console 2.4.1900 — Meridian FCU internal use only</div></body></html>`;

function getSession(req) {
  const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return m ? sessions.get(m[1]) : undefined;
}

function loginPage(msg = "") {
  return page(
    "MFCU Teller Console — Sign In",
    `<form method="POST" action="/login">
    <table class="box" cellpadding="0" cellspacing="0" width="380">
      <tr><td class="hdr" colspan="2">Teller Console Sign In</td></tr>
      ${msg ? `<tr><td colspan="2" class="err">&nbsp;${msg}</td></tr>` : ""}
      <tr><td class="lbl">Operator ID:</td>
          <td class="val"><input type="text" name="u" size="18"></td></tr>
      <tr><td class="lbl">Passcode:</td>
          <td class="val"><input type="password" name="p" size="18"></td></tr>
      <tr><td></td><td class="val"><input type="submit" value="Sign In"></td></tr>
    </table></form>`,
    "standalone"
  );
}

function sessionExpired(res) {
  html(
    res,
    page(
      "Session Expired",
      `<table class="box" cellpadding="4"><tr><td class="hdr">Notice</td></tr>
       <tr><td class="err">Your session has expired due to inactivity.</td></tr>
       <tr><td><a href="/" target="_top">Return to sign in</a></td></tr></table>`,
      "standalone"
    ),
    440
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.searchParams.get("slow") === "1") slowNext = true;
  if (url.searchParams.get("break") === "1") breakNext = true;
  if (url.searchParams.get("expire_after")) expireBudget = Number(url.searchParams.get("expire_after"));

  // ---- auth endpoints -----------------------------------------------------
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    if (p.get("u") === DEMO_USER && p.get("p") === DEMO_PASS) {
      const sid = crypto.randomBytes(8).toString("hex");
      sessions.set(sid, { user: DEMO_USER, hits: 0 });
      interstitialArmed = true;
      res.writeHead(302, { "Set-Cookie": `sid=${sid}; Path=/`, Location: "/console" });
      return res.end();
    }
    return html(res, loginPage("Invalid operator ID or passcode."), 401);
  }

  if (url.pathname === "/admin/expire-sessions" && req.method === "POST") {
    sessions.clear();
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("sessions cleared\n");
  }

  if (url.pathname === "/") return html(res, loginPage());

  // everything below requires a session
  const sess = getSession(req);
  if (!sess) return sessionExpired(res);
  if (expireBudget !== null) {
    if (expireBudget <= 0) {
      expireBudget = null; // one-shot
      sessions.clear();
      return sessionExpired(res);
    }
    expireBudget--;
  }
  sess.hits++;

  // ---- frameset shell -----------------------------------------------------
  if (url.pathname === "/console") {
    return html(
      res,
      `<html><head><title>MFCU Teller Console</title></head>
       <frameset cols="190,*" border="0" framespacing="0" frameborder="0">
         <frame name="nav" src="/nav" scrolling="no">
         <frame name="main" src="/main/home">
       </frameset></html>`
    );
  }

  if (url.pathname === "/nav") {
    return html(
      res,
      page(
        "nav",
        `<table class="box" width="158" cellpadding="2">
          <tr><td class="hdr">Functions</td></tr>
          <tr><td><a href="/main/home" target="main">Home</a></td></tr>
          <tr><td><a href="/main/member-search" target="main">Member Inquiry</a></td></tr>
          <tr><td><a href="/main/reports" target="main">Reports</a></td></tr>
          <tr><td><a href="/" target="_top">Sign Out</a></td></tr>
        </table>`
      )
    );
  }

  // ---- main-frame pages ---------------------------------------------------
  if (url.pathname === "/main/home") {
    if (interstitialArmed) {
      interstitialArmed = false;
      return html(
        res,
        page(
          "System Notice",
          `<table class="box" cellpadding="4" width="420">
            <tr><td class="hdr">Scheduled Maintenance Notice</td></tr>
            <tr><td>Core system maintenance window Sunday 02:00–04:00 ET.
                Batch postings may be delayed.</td></tr>
            <tr><td><form method="GET" action="/main/home">
                <input type="submit" value="Continue"></form></td></tr>
          </table>`
        )
      );
    }
    return html(
      res,
      page(
        "Home",
        `<table class="box" cellpadding="4" width="420">
          <tr><td class="hdr">Teller Console</td></tr>
          <tr><td>Signed in as <b>${sess.user}</b>. Select a function from the left.</td></tr>
        </table>`
      )
    );
  }

  if (url.pathname === "/main/member-search") {
    return html(
      res,
      page(
        "Member Inquiry",
        `<form method="GET" action="/main/results">
        <table class="box" cellpadding="3" width="420">
          <tr><td class="hdr" colspan="2">Member Inquiry</td></tr>
          <tr><td class="lbl">Member Number:</td>
              <td class="val"><input type="text" name="q" size="14"></td></tr>
          <tr><td></td><td class="val"><input type="submit" value="Search"></td></tr>
        </table></form>`
      )
    );
  }

  if (url.pathname === "/main/results") {
    if (breakNext) {
      breakNext = false;
      return html(res, page("Error", `<span class="err">HTTP 500 — ORA-00600 internal error, contact IT service desk.</span>`), 500);
    }
    if (slowNext) {
      slowNext = false;
      await new Promise((r) => setTimeout(r, 6000));
    }
    const q = (url.searchParams.get("q") || "").trim();
    const rec = MEMBERS[q];
    if (!rec) {
      return html(
        res,
        page(
          "Member Inquiry — Results",
          `<table class="box" cellpadding="4" width="420">
            <tr><td class="hdr">Member Inquiry</td></tr>
            <tr><td class="err">No member found matching number "${q}".</td></tr>
            <tr><td><a href="/main/member-search">New search</a></td></tr>
          </table>`
        )
      );
    }
    if (rec.restricted) {
      return html(
        res,
        page(
          "Access Restricted",
          `<table class="box" cellpadding="4" width="420">
            <tr><td class="hdr">Member Inquiry</td></tr>
            <tr><td class="err">Access restricted: this member record requires supervisor
                authorization (code S-71).</td></tr></table>`
        )
      );
    }
    const rows = rec.accounts
      .map(
        ([type, no, bal]) =>
          `<tr><td class="val">${type}</td><td class="val">${no}</td><td class="val" align="right">${bal}</td></tr>`
      )
      .join("");
    return html(
      res,
      page(
        `Member ${q}`,
        `<table class="box" cellpadding="3" width="480">
          <tr><td class="hdr" colspan="2">Member Profile</td></tr>
          <tr><td class="lbl">Member Number:</td><td class="val">${q}</td></tr>
          <tr><td class="lbl">Name:</td><td class="val">${rec.name}</td></tr>
          <tr><td class="lbl">Member Since:</td><td class="val">${rec.since}</td></tr>
        </table><br>
        <table class="box" cellpadding="3" width="480">
          <tr><td class="hdr" colspan="3">Accounts</td></tr>
          <tr><td class="lbl"><b>Type</b></td><td class="lbl"><b>Account #</b></td>
              <td class="lbl" align="right"><b>Current Balance</b></td></tr>
          ${rows}
        </table>`
      )
    );
  }

  if (url.pathname === "/main/reports") {
    return html(res, page("Reports", `<table class="box" cellpadding="4"><tr><td class="hdr">Reports</td></tr><tr><td>Module not licensed.</td></tr></table>`));
  }

  html(res, page("Not Found", `<span class="err">Unknown screen.</span>`), 404);
});

// A port collision is the single most likely first-run friction (a previous
// instance still running), so explain it rather than dumping a stack trace.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[target-app] Port ${PORT} is already in use — most likely this app is\n` +
        `             already running in another terminal.\n\n` +
        `  If so, nothing to do: http://127.0.0.1:${PORT} is live, go ahead and\n` +
        `  run 'npm run discover' / 'npm run replay'.\n\n` +
        `  To take the port over instead:\n` +
        `    PowerShell:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen |\n` +
        `                   ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `    bash:        kill $(lsof -ti tcp:${PORT})\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[target-app] MFCU Teller Console at http://127.0.0.1:${PORT}  (operator: ${DEMO_USER} / ${DEMO_PASS})`)
);

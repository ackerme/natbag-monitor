/* intro.js – פתיח: מטוס נוסעים בגישה לנחיתה טס ישר לעבר מי שפותח את האתר.
   • מופיע פעם אחת בכל ביקור (sessionStorage). להצגה מחדש: להוסיף ?intro לכתובת
   • לחיצה, מקש או "דלג" – מדלגים מיד
   • מי שביקש "הפחתת תנועה" במערכת ההפעלה לא רואה אותו בכלל
   • נטען בתחילת <body>, כך שהוא מכסה את הדף עוד לפני שהדף מצויר; הדף ממשיך להיטען מתחתיו */
(function () {
  "use strict";
  var KEY = "natbag-intro-seen";
  var force = /[?&]intro\b/.test(location.search);
  try { if (!force && sessionStorage.getItem(KEY)) return; } catch (e) { /* פרטי / חסום – מציגים */ }
  if (!force && window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try { sessionStorage.setItem(KEY, "1"); } catch (e) {}

  var css =
    "#natbag-intro{position:fixed;inset:0;z-index:9999;background:#1f2a30;overflow:hidden;cursor:pointer;" +
    "transition:opacity .45s ease;font-family:'IBM Plex Sans Hebrew',system-ui,sans-serif}" +
    "#natbag-intro.out{opacity:0;pointer-events:none}" +
    "#natbag-intro canvas{position:absolute;inset:0;width:100%;height:100%}" +
    "#natbag-intro .plane{position:absolute;left:0;top:0;width:1600px;height:800px;transform-origin:50% 50%}" +
    "#natbag-intro .title{position:absolute;left:0;right:0;bottom:12%;text-align:center;color:#e4e9eb;opacity:0;" +
    "transition:opacity .6s ease .15s}" +
    "#natbag-intro.on .title{opacity:1}" +
    "#natbag-intro .title b{display:block;font-size:clamp(1.6rem,5vw,2.6rem);font-weight:700;letter-spacing:-.01em}" +
    "#natbag-intro .title span{display:block;margin-top:4px;color:#9daab1;font-size:clamp(.85rem,2.4vw,1rem);" +
    "font-family:'IBM Plex Mono',ui-monospace,monospace;direction:ltr}" +
    "#natbag-intro .skip{position:absolute;top:16px;inset-inline-start:16px;background:none;border:1px solid #46565f;" +
    "color:#9daab1;font:inherit;font-size:.85rem;padding:6px 14px;border-radius:3px;cursor:pointer}" +
    "#natbag-intro .skip:hover{color:#e4e9eb;border-color:#9daab1}" +
    "@keyframes natbag-blink{0%,70%{opacity:0}75%,90%{opacity:1}100%{opacity:0}}" +
    "#natbag-intro .strobe{animation:natbag-blink 1s infinite}";

  /* מטוס נוסעים מלפנים (כמו שרואים אותו מהקרקע כשהוא בא לנחיתה): גוף, כנפיים עם זווית קלה כלפי מעלה,
     שני מנועים, זנב, כן נסע למטה, אורות נחיתה דולקים, ואורות ניווט – אדום בכנף השמאלית שלו (מימין לנו), ירוק בימנית */
  var svg =
    '<svg class="plane" viewBox="-100 -50 200 100" aria-hidden="true">' +
    '<defs><filter id="ni-glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>' +
    // זנב אנכי וייצב אופקי
    '<path d="M-2.2 -12 L0 -42 L2.2 -12 Z" fill="#c9d2d6"/>' +
    '<path d="M-3 -15 L-30 -19.5 L-30 -17.3 L-3 -11.5 Z M3 -15 L30 -19.5 L30 -17.3 L3 -11.5 Z" fill="#b9c3c8"/>' +
    // כנפיים (dihedral)
    '<path d="M-8 1 L-96 -9 L-97 -6.6 L-8 8 Z M8 1 L96 -9 L97 -6.6 L8 8 Z" fill="#d5dde0"/>' +
    '<path d="M-8 6.2 L-97 -6.6 L-8 8 Z M8 6.2 L97 -6.6 L8 8 Z" fill="#9daab1"/>' +
    // כן נסע
    '<g stroke="#7f8d94" stroke-width="1.6" stroke-linecap="round"><path d="M0 9 V19 M-13 7 V18 M13 7 V18"/></g>' +
    '<g fill="#1b252b"><circle cx="0" cy="20" r="2"/><circle cx="-13" cy="19" r="2.2"/><circle cx="13" cy="19" r="2.2"/></g>' +
    // מנועים
    '<g><circle cx="-31" cy="9" r="7" fill="#c3ccd0"/><circle cx="-31" cy="9" r="5" fill="#1b252b"/><circle cx="-31" cy="9" r="1.6" fill="#5d6f78"/>' +
    '<circle cx="31" cy="9" r="7" fill="#c3ccd0"/><circle cx="31" cy="9" r="5" fill="#1b252b"/><circle cx="31" cy="9" r="1.6" fill="#5d6f78"/></g>' +
    // גוף
    '<circle cx="0" cy="0" r="10.5" fill="#e4e9eb"/>' +
    '<path d="M-10.5 2 A10.5 10.5 0 0 0 10.5 2 A10.5 7 0 0 1 -10.5 2 Z" fill="#b9c3c8"/>' +
    // חלונות תא הטייס
    '<path d="M-7 -3.2 L-2.4 -4.6 L-2.4 -1.6 L-7.4 -0.6 Z M7 -3.2 L2.4 -4.6 L2.4 -1.6 L7.4 -0.6 Z M-1.6 -4.8 H1.6 V-1.7 H-1.6 Z" fill="#1b252b"/>' +
    // אורות נחיתה (קבועים) + הילה
    '<g fill="#fff6dc"><circle cx="-11" cy="5.5" r="4.5" filter="url(#ni-glow)" opacity=".85"/><circle cx="11" cy="5.5" r="4.5" filter="url(#ni-glow)" opacity=".85"/>' +
    '<circle cx="-11" cy="5.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/></g>' +
    // אורות ניווט ומהבהבים
    '<circle cx="-96.5" cy="-8" r="1.6" fill="#45d07a"/><circle cx="96.5" cy="-8" r="1.6" fill="#ff4b3a"/>' +
    '<g class="strobe" fill="#fff"><circle cx="-96.5" cy="-8" r="4" filter="url(#ni-glow)"/><circle cx="96.5" cy="-8" r="4" filter="url(#ni-glow)"/></g>' +
    "</svg>";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var box = document.createElement("div");
  box.id = "natbag-intro";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = '<canvas></canvas>' + svg +
    '<div class="title"><b>מוניטור נתב"ג</b><span>LLBG · TLV · 32.0055N 34.8854E</span></div>' +
    '<button class="skip" type="button">דלג</button>';
  (document.body || document.documentElement).appendChild(box);

  var cv = box.querySelector("canvas"), ctx = cv.getContext("2d"), plane = box.querySelector(".plane");
  var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  function size() {
    W = box.clientWidth; H = box.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener("resize", size);

  var DUR = 2600;           // עד שהמטוס עובר מעלינו
  var D0 = 34, D1 = 0.32;    // מרחק התחלה/סוף (יחסי). גודל = 1/מרחק → המטוס "מאיץ" לקראתנו כמו במציאות
  var t0 = null, done = false, raf = 0;

  /* אורות מסלול בפרספקטיבה: שתי שורות ענבר בצדדים וקו לבן במרכז, זורמים לעבר הצופה */
  function runway(now) {
    var hy = H * 0.5, cx = W / 2;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(70,86,95,.55)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();            // אופק
    var speed = 0.0009, phase = (now * speed) % 1;
    for (var i = 0; i < 26; i++) {
      var z = 26 - i - phase;                     // מרחק של שורת אורות
      if (z <= 0.4) continue;
      var k = 1 / z;
      var y = hy + H * 0.9 * k;
      if (y > H + 20) continue;
      var half = Math.max(W, H * 0.9) * 0.5 * k, r = Math.max(1.3, 5 * k * (H / 700));
      var a = Math.min(1, 0.55 + k * 2.5);
      ctx.fillStyle = "rgba(232,178,58," + a + ")";
      ctx.beginPath(); ctx.arc(cx - half, y, r, 0, 7); ctx.arc(cx + half, y, r, 0, 7); ctx.fill();
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(228,233,235," + a * 0.8 + ")";
        ctx.fillRect(cx - r * 0.7, y - r * 2.2, r * 1.4, r * 4.4);
      }
    }
  }

  function frame(now) {
    if (done) return;
    if (t0 == null) { t0 = now; box.classList.add("on"); }
    var p = Math.min(1, (now - t0) / DUR);
    runway(now);
    var d = D0 + (D1 - D0) * p;                    // המרחק יורד בקצב קבוע
    var scale = (Math.max(W, H * 0.9) / 1600) * (0.9 / d);   // ה-SVG בגודל 1600 כדי שיישאר חד מקרוב
    var cy = H * 0.46 - (H * 0.06) / d;             // קצת מעל האופק, ועולה מעט כשהוא מתקרב – ממלא את המסך מולך
    var bank = Math.sin(p * 3.1) * 2.5 * (1 - p);   // נדנוד קטן של הכנפיים בגישה
    plane.style.transform = "translate(" + (W / 2 - 800) + "px," + (cy - 400) + "px) scale(" + scale + ") rotate(" + bank + "deg)";
    if (p >= 1) return finish();
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    box.classList.add("out");
    window.removeEventListener("resize", size);
    setTimeout(function () { box.remove(); style.remove(); }, 500);
  }

  box.addEventListener("click", finish);
  window.addEventListener("keydown", function k() { finish(); window.removeEventListener("keydown", k); });
  setTimeout(finish, DUR + 2500);                  // רשת ביטחון: גם אם requestAnimationFrame לא רץ (לשונית ברקע)
  raf = requestAnimationFrame(frame);
})();

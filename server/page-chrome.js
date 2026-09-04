const { escapeHtml } = require("./support");

// Site chrome ported from the MazeJam repo (functions/_shared/page-chrome.js)
// so the local site looks exactly like the hosted one. Keep the markup and the
// nav script in sync with MazeJam when its design changes; the CSS lives in
// public/site.css (copied verbatim from MazeJam's public/site.css).

const BRAND_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="3" y="3" width="58" height="58" rx="14" fill="#070811" stroke="#34e7f0" stroke-width="3"/><path d="M 165.946 76.712 C 159.054 83.745, 151.150 92.200, 148.382 95.500 C 142.518 102.491, 129.636 119.673, 125.811 125.605 C 117.711 138.165, 105.403 164.668, 100.583 179.928 C 91.142 209.813, 86.406 247.119, 88.918 271.817 C 92.237 304.451, 98.973 327.972, 112.667 354.753 C 128.086 384.906, 143.270 403.605, 169 424.125 C 179.162 432.229, 191.766 440.734, 201.500 446.053 C 208.829 450.059, 236.752 464, 237.445 464 C 237.720 464, 240.320 465.099, 243.223 466.442 C 247.723 468.524, 254.400 471.171, 276 479.437 C 277.925 480.174, 282.760 481.991, 286.744 483.475 C 290.728 484.958, 294.233 486.568, 294.532 487.053 C 295.060 487.907, 286.230 496.696, 275 506.493 C 261.077 518.641, 214.090 562.859, 212.653 565.166 C 211.906 566.367, 211.986 567.278, 212.942 568.430 C 213.671 569.309, 227.820 576.718, 244.384 584.896 C 277.074 601.034, 277.583 601.272, 296 608.972 C 302.875 611.846, 311.707 615.540, 315.626 617.180 C 323.449 620.454, 322.748 619.534, 329.224 635 C 331.412 640.225, 334.674 647.650, 336.473 651.500 C 344.587 668.862, 348.182 677.901, 357.156 703.500 C 367.011 731.613, 370.467 744.776, 378.559 785 C 381.584 800.040, 386.380 833.619, 388.556 855 C 390.875 877.796, 395.515 890.997, 406.397 905.760 C 421.414 926.135, 447.503 941.627, 473.500 945.609 C 479.172 946.477, 568.364 946.292, 574.500 945.399 C 579.499 944.671, 591.192 941.693, 597.625 939.509 C 619.221 932.177, 641.959 912.391, 652.796 891.500 C 658.804 879.918, 660.840 872.621, 662.564 856.500 C 666.055 823.845, 674.754 775.610, 683.122 742.500 C 688.176 722.503, 689.211 719.129, 697.846 694.500 C 705.837 671.706, 706.738 669.356, 715.423 648.633 C 718.912 640.310, 722.991 630.217, 724.488 626.204 C 726.039 622.047, 728.132 618.307, 729.355 617.510 C 730.535 616.740, 736.450 614.116, 742.500 611.677 C 748.550 609.239, 756.650 605.787, 760.500 604.006 C 767.436 600.799, 775.247 597.278, 782 594.315 C 787.305 591.988, 811.054 580.613, 824 574.198 C 838.315 567.105, 838.579 566.404, 829.802 558.804 C 773.219 509.804, 749.509 488.673, 749.201 486.966 C 748.967 485.672, 751.365 484.497, 760.201 481.578 C 771.725 477.771, 786.898 472.456, 790.500 470.964 C 827.875 455.486, 828.293 455.279, 846.790 443.237 C 867.506 429.749, 887.481 411.928, 900.855 395 C 907.654 386.394, 908.729 384.832, 917.719 370.500 C 931.517 348.504, 942.358 318.455, 947.122 289 C 951.042 264.769, 949.872 228.655, 944.385 204.500 C 940.602 187.849, 931.600 161.309, 925.730 149.500 C 917.767 133.483, 902.730 109.969, 891.518 96 C 880.509 82.285, 863.144 64, 861.129 64 C 858.797 64, 857 65.949, 857 68.478 C 857 69.621, 858.104 73.937, 859.454 78.070 C 868.745 106.515, 876 149.063, 876 175.101 C 876 194.060, 871.719 214.442, 863.326 235.446 C 851.870 264.113, 826.153 291.161, 797.492 304.687 C 780.987 312.476, 772.971 314.922, 754.605 317.775 C 744.335 319.370, 726.586 319.500, 518.500 319.500 C 308.024 319.500, 292.795 319.386, 282.585 317.730 C 259.578 313.999, 238.738 306.237, 222 295.164 C 207.028 285.260, 187.810 262.714, 178.406 244.022 C 172.039 231.365, 166.811 212.819, 164.503 194.699 C 162.612 179.851, 162.620 173.702, 164.554 153.627 C 166.954 128.726, 171.461 107.035, 179.434 82.021 C 183.445 69.437, 183.727 64.676, 180.488 64.212 C 179.043 64.004, 174.953 67.520, 165.946 76.712 M 358.428 591.327 C 357.864 592.795, 361.306 609.202, 363.115 613.668 C 374.553 641.919, 394.743 654.991, 434.500 659.885 C 445.312 661.216, 445.582 660.756, 440.354 649.917 C 429.071 626.524, 411.393 611.706, 377.834 597.512 C 368.066 593.380, 359.818 590, 359.505 590 C 359.193 590, 358.708 590.597, 358.428 591.327 M 684 591.750 C 680.225 593.499, 678.017 594.436, 668 598.536 C 638.213 610.728, 618.176 627.799, 606.699 650.760 C 602.133 659.896, 602.503 661.240, 609.364 660.440 C 631.263 657.886, 648.186 653.088, 659.959 646.094 C 663.770 643.830, 669.264 639.312, 672.338 635.916 C 678.518 629.087, 685.628 615.408, 688.408 605 C 692.019 591.476, 691.996 591.617, 690.721 590.806 C 689.039 589.738, 688.039 589.878, 684 591.750" fill="#34e7f0" fill-rule="evenodd" transform="translate(4.4 4.3) scale(.0532)"/></svg>`;

const ACCOUNT_ICON_SVG = `<svg class="account-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 12.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 2c-4.2 0-7.4 2.3-7.4 5.2 0 .8.6 1.4 1.4 1.4h12c.8 0 1.4-.6 1.4-1.4 0-2.9-3.2-5.2-7.4-5.2Z"></path></svg>`;

const TOPBAR_NAV_SCRIPT = `(() => {
      const bar = document.currentScript && document.currentScript.closest(".topbar");
      if (!bar || bar.dataset.navReady) return;
      bar.dataset.navReady = "1";
      const drops = Array.from(bar.querySelectorAll("details.nav-dropdown"));
      drops.forEach((drop) => {
        drop.addEventListener("toggle", () => {
          if (drop.open) drops.forEach((other) => { if (other !== drop) other.open = false; });
        });
      });
      document.addEventListener("click", (event) => {
        drops.forEach((drop) => {
          if (drop.open && !drop.contains(event.target)) drop.open = false;
        });
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") drops.forEach((drop) => { drop.open = false; });
      });
      const path = window.location.pathname;
      const view = new URLSearchParams(window.location.search).get("view") || "";
      bar.querySelectorAll(".topbar-nav a[href]").forEach((link) => {
        const url = new URL(link.getAttribute("href"), window.location.origin);
        const linkView = url.searchParams.get("view") || "";
        const samePath = url.pathname === path || (url.pathname !== "/" && path.startsWith(url.pathname + "/"));
        if (!samePath || (linkView && linkView !== view)) return;
        link.classList.add("is-active");
        const summary = link.closest("details") && link.closest("details").querySelector("summary");
        if (summary) summary.classList.add("is-active");
      });
    })();`;

function pageHead({ title, description = "", extraHeadHtml = "" } = {}) {
  const safeTitle = escapeHtml(title || "Maze Bench");
  const safeDescription = escapeHtml(
    description || "Maze Bench — build and play persistent 3D worlds, then benchmark models against them."
  );

  return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}">
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/site.css">
    ${extraHeadHtml}`;
}

function accountActionsHtml(remoteStatus) {
  // Only surface the account icon once connected; no "Connect" prompt when not.
  if (remoteStatus?.connected) {
    const name =
      remoteStatus.user?.name || remoteStatus.user?.display_name || remoteStatus.user?.mazebench_user_id || "Account";
    const accountUrl = remoteAccountUrl(remoteStatus.origin);
    return `<a class="account-button account-icon-button" href="${escapeHtml(accountUrl)}" title="${escapeHtml(name)} — managed by ${escapeHtml(
      remoteStatus.origin || "mazebench.com"
    )}" target="_blank" rel="noopener noreferrer">${ACCOUNT_ICON_SVG}</a>`;
  }

  return "";
}

function remoteAccountUrl(origin) {
  try {
    const remote = new URL(String(origin || "https://mazebench.com"));
    if (remote.protocol !== "http:" && remote.protocol !== "https:") throw new Error("invalid protocol");
    return new URL("/user", remote).href;
  } catch {
    return "https://mazebench.com/user";
  }
}

function topbar({ rightHtml = "", extraNavHtml = "", extraHtml = "" } = {}) {
  return `<header class="topbar">
      <a class="brand-link" href="/"><span class="brand-mark" aria-hidden="true">${BRAND_MARK_SVG}</span>Maze Bench</a>
      <nav class="topbar-nav" aria-label="Site">
        <a class="nav-link" href="/build">Build</a>
        <a class="nav-link" href="/agent">Agent</a>
        <a class="nav-link" href="/leaderboard">Leaderboard</a>
        <a class="nav-link" href="/train">Train</a>
        ${extraNavHtml}
      </nav>
      <div class="topbar-end">
        ${extraHtml}
        <div class="account-actions" aria-label="Account">${rightHtml}</div>
      </div>
      <script>${TOPBAR_NAV_SCRIPT}</script>
    </header>`;
}

function siteFooter() {
  return `<footer class="site-footer">
      <span>Maze Bench (local)</span>
      <a class="text-link" href="/build">Build</a>
      <a class="text-link" href="/agent">Agent</a>
      <a class="text-link" href="/leaderboard">Leaderboard</a>
      <a class="text-link" href="/train">Train</a>
      <a class="text-link" href="https://mazebench.com">mazebench.com</a>
    </footer>`;
}

module.exports = {
  ACCOUNT_ICON_SVG,
  BRAND_MARK_SVG,
  TOPBAR_NAV_SCRIPT,
  accountActionsHtml,
  pageHead,
  siteFooter,
  topbar
};

/** Owned minimal fixture; no site tokens or third-party scripts execute. */
export const alibabaInterception = (padding = 90000) => `<!doctype html>
<html><head><title>Captcha Interception</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'">
<style>/*${'x'.repeat(padding)}*/</style>
<script src="https://g.alicdn.com/AWSC/CAPTCHA/0.0.1/awsc.js"></script>
<script src="https://g.alicdn.com/bsop-static/sufei-punish/0.1.130/build/punishpage.min.js"></script>
</head><body><div id="baxia-punish"><p>Sorry, we have detected unusual traffic from your network.</p>
<form id="nc-verify-form" action="/product/_____tmd_____/verify/" method="GET"><button>Verify</button></form>
</div></body></html>`;

export const ordinaryAlibabaAssets = () =>
  alibabaInterception(0)
    .replace(
      '<title>Captcha Interception</title>',
      '<title>Original product</title>',
    )
    .replace(
      /<div id="baxia-punish">[\s\S]*?<\/div>/,
      '<main>Original public record 42</main>',
    );

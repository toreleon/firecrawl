/** Owned block-page shape. Assets cannot execute; support actions stay local. */
export const autotraderBlock = () => `<!doctype html><html><head>
<title>Autotrader - page unavailable</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'">
<link href="/akamai-block/block-images/css/app.css" rel="stylesheet">
<script src="/akamai-block/block-images/js/app.js"></script>
<style>#contactform { display: none }</style>
</head><body><main><h1>We're sorry for any inconvenience, but the site is currently unavailable.</h1>
<p>Incident Number: 18.owned.123456.fixture</p></main>
<div id="contactform"><form id="atcform" action="/unexpected-feedback" method="post">
<input name="email"><div class="g-recaptcha"></div><button>Submit</button></form></div>
</body></html>`;

export const ordinaryAutotrader = () =>
  autotraderBlock()
    .replace(
      '<title>Autotrader - page unavailable</title>',
      '<title>Original vehicle</title>',
    )
    .replace(
      /<main>[\s\S]*?<\/main>/,
      '<main>Original public vehicle 42</main>',
    );

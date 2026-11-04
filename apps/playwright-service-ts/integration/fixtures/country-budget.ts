export const countryFixture = (mode: string, destination: string) => {
  const links = `<a href="https://attacker.invalid/site/owned/42.p?skuId=42&intl=nosplash">Other origin</a>
    <a href="/wrong?skuId=42&intl=nosplash">Other path</a>
    <a href="${destination.replace('skuId=42', 'skuId=43')}">Other SKU</a>`;
  const valid = `<a id="country" href="${mode === 'rewrite' ? '/wrong?intl=nosplash' : destination}">United States</a>`;
  if (mode === 'delayed')
    return `<main>Loading...</main><script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify('<h1>Choose a country</h1>' + links + valid)}},350)</script>`;
  return `<!doctype html><title>Owned country selector</title><h1>Choose a country</h1>${links}${mode === 'wrong' ? '' : valid}
    ${mode === 'rewrite' ? `<script>setTimeout(()=>document.querySelector('#country').href=${JSON.stringify(destination)},350)</script>` : ''}`;
};

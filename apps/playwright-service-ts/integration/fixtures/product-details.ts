export const productDetailsFixture = (mode: string) => {
  const clipped = mode === 'clipped' || mode === 'required' || mode === 'off';
  const covered = mode === 'covered';
  const update = mode !== 'unconfirmed';
  return `<!doctype html><title>Owned product 42</title><body>
    <main>Original public product 42</main>
    <button type="button" aria-expanded="false" aria-controls="details"
      style="${clipped ? 'position:fixed;left:-1000px;top:10px;' : 'position:relative;'}width:180px;height:40px"
      onclick="window.nativeClicks=(window.nativeClicks||0)+1;document.querySelector('#click-count').textContent=String(window.nativeClicks);${update ? "this.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false;" : ''}">Product Details</button>
    ${covered ? '<div style="position:fixed;inset:0;z-index:999;background:white">Owned overlay</div>' : ''}
    <section id="details" hidden>Expanded public details 42</section><output id="click-count">0</output>
    <script>window.nativeClicks=0</script>
    </body>`;
};

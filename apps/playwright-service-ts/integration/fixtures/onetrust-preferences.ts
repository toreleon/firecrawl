export const oneTrustPreferencesFixture = (mode: string) => {
  const standard = mode === 'standard';
  const category = (
    group: string,
    checked = true,
  ) => `<div class="ot-cat-item" data-optanongroupid="${group}"><div class="ot-tgl">
    <input type="checkbox" class="category-switch-handler" id="ot-group-id-${group}" data-optanongroupid="${group}" ${checked ? 'checked' : ''} onchange="document.querySelector('#toggles').textContent=String(Number(document.querySelector('#toggles').textContent)+1);${mode === 'retoggled' ? 'this.checked=true;' : mode === 'rewrite' ? "const other=document.querySelector('#ot-group-id-C0003');other.id='ot-group-id-C0002';other.setAttribute('data-optanongroupid','C0002');other.style.width='20px';other.style.height='20px';" : ''}">
    <label class="ot-switch" for="ot-group-id-${group}">Optional category ${group}</label></div></div>`;
  const open = `document.querySelector('#opens').textContent=String(Number(document.querySelector('#opens').textContent)+1);document.querySelector('#onetrust-pc-sdk').hidden=false;`;
  const save = `<button class="save-preference-btn-handler" onclick="document.querySelector('#saves').textContent=String(Number(document.querySelector('#saves').textContent)+1);document.querySelector('#saved').textContent=Array.from(document.querySelectorAll('input.category-switch-handler')).map(i=>i.checked?'1':'0').join('');${mode === 'unconfirmed' ? '' : "document.querySelector('#onetrust-banner-sdk').hidden=true;document.querySelector('#onetrust-pc-sdk').hidden=true;"}">Confirm My Choices</button>`;
  return `<!doctype html><title>Owned public product</title><style>
    [hidden]{display:none!important}#onetrust-banner-sdk{position:fixed;bottom:0;left:0;width:100%;background:white;z-index:2;padding:12px}
    #onetrust-pc-sdk{position:fixed;inset:15px;background:white;z-index:3;overflow:auto;padding:20px}
    .ot-tgl input{position:absolute;opacity:0;width:0;height:0}.ot-switch{display:block;padding:12px;background:#ddd;margin:8px}
    #cover{position:absolute;inset:0;z-index:5;background:#fff8}
    </style><main>Original public product 42</main>
    <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false">Product Details</button><section id="details" hidden>Expanded public details 42</section>
    <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler" onclick="document.querySelector('#accepts').textContent='1';document.querySelector('#onetrust-banner-sdk').hidden=true">Accept All Cookies</button>
    ${standard ? `<button id="onetrust-pc-btn-handler" onclick="${open}">Cookie Settings</button>` : ''}</div>
    ${standard ? '' : `<button data-cookie-settings aria-haspopup="dialog" onclick="${open}">Cookie Settings</button>`}
    <div id="onetrust-pc-sdk" hidden>
    <div class="ot-cat-item" data-optanongroupid="C0001">${mode === 'unknown' ? category('C0001') : '<div class="ot-always-active">Always Active</div>'}</div>
    ${category('C0002')}${category('C0003', false)}${category('C0004')}
    ${save}${mode === 'ambiguous' ? save : ''}
    ${mode === 'covered' ? '<div id="cover">Owned blocking overlay</div>' : ''}
    </div><output id="opens">0</output><output id="toggles">0</output><output id="saves">0</output><output id="saved">unset</output><output id="accepts">0</output>`;
};

const STYLE = `
:root{--bg:#f4f6f9;--panel:#fff;--ink:#1d2433;--muted:#5d6879;--line:#dde3ea;--accent:#1f6feb;--accent-ink:#fff;--soft:#eaf1fd;--ok:#1a7f37;--bad:#c62828;--warn:#9a6700;--mono:Consolas,"Cascadia Mono",Menlo,monospace}
html,html *{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.45 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:10px 20px;background:#0f2742;color:#fff}
header h1{font-size:17px;margin:0;font-weight:600;letter-spacing:.2px}
header .sub{opacity:.75;font-size:12.5px}
header .grow{flex:1}
header button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.45)}
header button:hover{background:rgba(255,255,255,.12)}
.wrap{display:flex;min-height:calc(100% - 52px)}
nav{width:236px;flex:none;padding:14px 10px;border-right:1px solid var(--line);background:#fbfcfd}
nav button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:9px 12px;border-radius:7px;margin-bottom:2px;color:var(--ink);font-size:14px}
nav button small{display:block;color:var(--muted);font-size:12px;margin-top:1px;font-weight:400}
nav button:hover{background:#eef2f6}
nav button.on{background:var(--soft);color:#0b4bbd;font-weight:600}
main{flex:1;padding:18px 26px 40px;max-width:1100px}
h2{font-size:19px;margin:2px 0 4px}
.blurb{color:var(--muted);margin:0 0 14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.card h3{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:0 0 10px}
.row{display:grid;grid-template-columns:200px 1fr;gap:6px 14px;align-items:start;margin:8px 0}
.row>label{padding-top:6px;font-weight:500}
.help{color:var(--muted);font-size:12.5px;margin-top:3px}
input[type=text],textarea,select{width:100%;padding:6px 9px;border:1px solid #c8d1dc;border-radius:6px;font:inherit;background:#fff;color:inherit}
textarea{min-height:64px;font-family:var(--mono);font-size:12.5px}
input[type=text]:focus,textarea:focus,select:focus{outline:2px solid #9cc0fa;border-color:var(--accent)}
.pathline{display:flex;gap:6px}
.pathline input{flex:1;font-family:var(--mono);font-size:12.5px}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #c8d1dc;background:#fff;color:var(--ink);cursor:pointer;white-space:nowrap}
button:hover{background:#f1f4f8}
button:disabled{opacity:.55;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;padding:8px 22px}
button.primary:hover{background:#1a5fd0}
.check{display:flex;gap:8px;align-items:flex-start;padding-top:5px}
.check input{margin-top:3px}
.params{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center;margin-top:8px}
.params select{max-width:320px}
.params .pname{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:12.5px}
.drop{border:2px dashed #b9c6d6;border-radius:9px;padding:14px;text-align:center;color:var(--muted);margin-top:8px;transition:background .15s}
.drop.over{background:var(--soft);border-color:var(--accent);color:#0b4bbd}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:#eef2f6;border-radius:14px;padding:3px 10px;font-family:var(--mono);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip b{cursor:pointer;margin-left:6px;color:var(--muted)}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.status{font-weight:600}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.status.run{color:var(--warn)}
pre.log{background:#0e1726;color:#d6e2f0;border-radius:8px;padding:10px 12px;max-height:300px;overflow:auto;font:12.5px/1.5 var(--mono);margin:10px 0 0;white-space:pre-wrap;word-break:break-word}
pre.log .f{color:#ff8a80}pre.log .o{color:#8be28b}pre.log .n{color:#ffd479}
table.files{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
table.files td{border-top:1px solid var(--line);padding:5px 6px}
table.files td:first-child{font-family:var(--mono);font-size:12.5px;word-break:break-all}
table.files td:last-child{text-align:right;white-space:nowrap}
a{color:var(--accent);text-decoration:none;cursor:pointer}
a:hover{text-decoration:underline}
.viewer{position:fixed;inset:5% 6%;background:#fff;border-radius:10px;box-shadow:0 18px 60px rgba(0,0,0,.35);display:none;flex-direction:column;z-index:10}
.viewer.on{display:flex}
.viewer .bar{display:flex;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.viewer .bar span{flex:1;font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer pre{flex:1;margin:0;overflow:auto;padding:12px 14px;font:12.5px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}
.shade{position:fixed;inset:0;background:rgba(10,20,35,.45);display:none;z-index:9}
.shade.on{display:block}
.hidden{display:none!important}
.gone{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;font-size:16px;color:var(--muted);z-index:20}
@media (max-width:800px){nav{width:160px}.row{grid-template-columns:1fr}}
`;

const SCRIPT = `
var TOKEN = '__TOKEN__';
var WINDOWS = __WINDOWS__;
var RPT = 'Report files (*.rpt)|*.rpt|All files (*.*)|*.*';
var RDL = 'Report definitions (*.rdl)|*.rdl|All files (*.*)|*.*';
var JSONF = 'JSON files (*.json)|*.json|All files (*.*)|*.*';
var PDF = 'PDF files (*.pdf)|*.pdf|All files (*.*)|*.*';
var AXIS = [['', 'As stored in the report'], ['0%', '0%  (12%)'], ['0.0%', '0.0%  (12.3%)'], ['0.00%', '0.00%  (12.34%)'], ['#,##0', '#,##0  (1,235)'], ['#,##0.00', '#,##0.00  (1,234.56)'], ['$#,##0', '$#,##0  ($1,235)'], ['$#,##0.00', '$#,##0.00  ($1,234.56)'], ['0', '0  (1235)'], ['0.00', '0.00  (1234.56)']];
var TABS = [
  { id: 'convert', title: 'Convert to SSRS', small: 'one, many or a whole folder', command: 'convert',
    blurb: 'Turns .rpt reports into SSRS .rdl files. Pick one report, several, or a folder (its subfolders are included and kept). Tick "Split subreports" to also write every part of a report as a report of its own.',
    input: { label: 'Reports', filter: RPT, ext: /\\.(rpt|json)$/i },
    groups: [
      { title: 'Report names and section', fields: [
        { id: 'prefix', type: 'text', label: 'Prefix', help: 'Optional. The short name the report item names are built from, for example Monthly_Pack gives Monthly_Pack_Tab_1. Left empty, the report file name is used.', placeholder: 'e.g. Monthly_Pack' },
        { id: 'sectionId', type: 'number', label: 'Section ID', help: 'Optional. Converts for this section_id value: what the report hides for other sections is left out.', placeholder: 'e.g. 12' } ] },
      { title: 'Subreports', fields: [
        { id: 'splitSubreports', type: 'check', label: 'Split subreports', help: 'Also writes each part the report prints as a report of its own, numbered in print order, in a "<name>_parts" folder.' },
        { id: 'partsFormat', type: 'select', label: 'Parts layout', options: [['standalone', 'Standalone: as each part designs itself'], ['report', 'As printed: in its box with its title and rules']], enableIf: 'splitSubreports', help: 'How each part split from the report is laid out. Used when Split subreports is ticked.' },
        { id: 'separateSubreports', type: 'check', label: 'Subreports as separate files', help: 'Writes subreports as files of their own that the main report calls, instead of inside it.' } ] },
      { title: 'Data', fields: [
        { id: 'sharedDataSource', type: 'text', label: 'Shared data source', help: 'Optional. The name of the shared data source on the report server the reports use.' },
        { id: 'parameters', type: 'params', label: 'Fixed parameter values', help: 'Convert for a fixed value of a parameter: what its show/hide formulas hide for that value is left out. Only parameters that decide what is shown are listed, with the values the reports test for.' },
        { id: 'chartAxisFormat', type: 'select', label: 'Chart axis format', options: AXIS, help: 'Value-axis format for charts whose format is not stored in the report.' } ] },
      { title: 'Output', fields: [
        { id: 'pageNumber', type: 'check', label: 'Page numbers', help: 'Adds "Page N" at the right of the page footer.' },
        { id: 'rdlOnly', type: 'check', label: 'RDL files only', help: 'Writes only the .rdl files: no review checklist, no .sql or .code.vb beside them, no check.txt.' } ] } ] },
  { id: 'compare', title: 'Data check', small: 'original PDF vs converted', command: 'compare',
    blurb: 'Checks that the converted reports show exactly the same data as the original, to the cent. Give the original report as users print it today (all parts merged into one PDF) and the converted reports rendered on the report server and saved as PDF. Each converted report is found in the original and every amount, percent and date it shows is compared.',
    input: { label: 'Converted report PDFs', filter: PDF, ext: /\\.pdf$/i },
    groups: [ { title: 'Original', fields: [
      { id: 'original', type: 'file', filter: PDF, label: 'Original report PDF', help: 'The full original report saved as PDF, all subreports included, run with the same parameter values as the converted reports.' } ] } ] },
  { id: 'check', title: 'Check RDL files', small: 'find layout problems', command: 'check',
    blurb: 'Checks finished .rdl files: custom code left, items over each other or cut off, the body wider than the page, and the team template checks: headings shown as Expr, default names, empty rows and the standard parameters.',
    input: { label: 'RDL files', filter: RDL, ext: /\\.rdl$/i },
    groups: [] },
  { id: 'headers', title: 'Header text', small: 'titles, headings, chart titles', command: 'headers',
    blurb: 'Lists the header text of reports: report, page and group headers, column headings and chart titles.',
    input: { label: 'Reports', filter: RPT, ext: /\\.(rpt|json)$/i },
    groups: [ { title: 'Options', fields: [
      { id: 'format', type: 'select', label: 'Format', options: [['txt', 'Text'], ['csv', 'CSV (opens in Excel)'], ['json', 'JSON']] },
      { id: 'all', type: 'check', label: 'Everything', help: 'Adds footers, details and field objects.' } ] } ] },
  { id: 'json', title: 'RPT and JSON', small: 'to JSON, back, round trip', commandField: 'mode',
    blurb: 'Writes reports as JSON and JSON back as reports, or checks that a report survives the round trip unchanged.',
    input: { label: 'Files', filter: RPT + '|' + JSONF, ext: /\\.(rpt|json)$/i },
    groups: [ { title: 'Options', fields: [
      { id: 'mode', type: 'select', label: 'Task', options: [['to-json', '.rpt to .json'], ['to-rpt', '.json to .rpt'], ['verify', 'Round trip check of .rpt files']] },
      { id: 'hex', type: 'check', label: 'Hex instead of base64', showIf: 'mode=to-json' },
      { id: 'noMetadata', type: 'check', label: 'No metadata', showIf: 'mode=to-json' },
      { id: 'noDecode', type: 'check', label: 'Do not decode streams', showIf: 'mode=to-json' },
      { id: 'noOriginal', type: 'check', label: 'Leave out the original bytes', showIf: 'mode=to-json' },
      { id: 'compact', type: 'check', label: 'Compact JSON', showIf: 'mode=to-json' },
      { id: 'noVerify', type: 'check', label: 'Skip the check after writing', showIf: 'mode=to-rpt' },
      { id: 'cfbVersion', type: 'select', label: 'File version', options: [['', 'Same as before'], ['3', '3'], ['4', '4']], showIf: 'mode=to-rpt' } ] } ] },
  { id: 'diag', title: 'Diagnostics', small: 'inspect, charts, layout, widths', commandField: 'tool',
    blurb: 'Looks inside reports when something does not convert as expected. Charts and layout hide all names and text, so their output is safe to share.',
    input: { label: 'Files', filter: RPT + '|' + RDL, ext: /\\.(rpt|json|rdl)$/i },
    groups: [ { title: 'Options', fields: [
      { id: 'tool', type: 'select', label: 'Tool', options: [['inspect', 'Inspect: decoded details of a .rpt'], ['charts', 'Charts: how each chart is stored'], ['layout', 'Layout: sections and objects showing a text'], ['check-width', 'Widths: what in an .rdl reaches past the page']] },
      { id: 'texts', type: 'textarea', label: 'Texts to look for', help: 'One per line. Use #N for subreport N.', showIf: 'tool=layout' },
      { id: 'sections', type: 'check', label: 'All sections', showIf: 'tool=layout' } ] } ] },
];

var settings = {};
var state = {};
var saving = null;

function $(id) { return document.getElementById(id); }
function el(tag, attrs, kids) {
  var e = document.createElement(tag);
  for (var k in attrs || {}) {
    if (k === 'text') e.textContent = attrs[k];
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
function api(path, opts) {
  opts = opts || {};
  var headers = { 'x-token': TOKEN };
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  return fetch('/api/' + path, { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: headers, body: opts.body }).then(function (r) {
    return r.json().then(function (v) { if (!r.ok) throw new Error(v.error || r.statusText); return v; });
  });
}
function key(tab, id) { return tab + '.' + id; }
function remember(tab, id, value) {
  settings[tab ? key(tab, id) : id] = value;
  clearTimeout(saving);
  saving = setTimeout(function () { api('settings', { json: settings }).catch(function () {}); }, 400);
}
function valueOf(tab, f) {
  if (f.type === 'params') {
    var chosen = settings[key(tab, f.id)] || {};
    var list = (state[tab] && state[tab].params) || [];
    return list.filter(function (p) { return chosen[p.name] !== undefined && chosen[p.name] !== null; }).map(function (p) { return p.name + '=' + chosen[p.name]; }).join('\\n');
  }
  var e = $(key(tab, f.id));
  if (!e) return undefined;
  if (f.type === 'check') return e.checked;
  return e.value;
}
function visible(tab, spec) {
  spec.groups.forEach(function (g) {
    g.fields.forEach(function (f) {
      if (f.enableIf) {
        var source = null;
        spec.groups.forEach(function (h) { h.fields.forEach(function (x) { if (x.id === f.enableIf) source = x; }); });
        var enabled = !!(source && valueOf(tab, source));
        $(key(tab, f.id)).disabled = !enabled;
        $('row-' + key(tab, f.id)).style.opacity = enabled ? '' : '0.55';
      }
      if (!f.showIf) return;
      var parts = f.showIf.split('=');
      var src = null;
      spec.groups.forEach(function (h) { h.fields.forEach(function (x) { if (x.id === parts[0]) src = x; }); });
      var v = src ? valueOf(tab, src) : '';
      var on = parts.length > 1 ? v === parts[1] : !!v;
      $('row-' + key(tab, f.id)).classList.toggle('hidden', !on);
    });
  });
}
function pickPaths(kind, filter, multiple, start) {
  return api('pick', { json: { kind: kind, filter: filter, multiple: multiple, start: start || '' } });
}
function uploadFiles(tab, area, files, single) {
  var st = state[tab];
  return api('reset-uploads', { json: { job: st.job, area: area } }).then(function () {
    var root = '';
    var chain = Promise.resolve();
    var done = 0;
    files.forEach(function (f) {
      chain = chain.then(function () {
        setStatus(tab, 'Uploading ' + (++done) + ' of ' + files.length + '...', 'run');
        return fetch('/api/upload?job=' + st.job + '&area=' + area + '&path=' + encodeURIComponent(f.path), { method: 'PUT', headers: { 'x-token': TOKEN }, body: f.file })
          .then(function (r) { return r.json(); }).then(function (v) { if (v.error) throw new Error(v.error); root = single ? v.file : v.root; });
      });
    });
    return chain.then(function () { setStatus(tab, '', ''); return root; });
  });
}
function browserPick(tab, area, accept, folder, multiple, single) {
  return new Promise(function (done) {
    var input = el('input', { type: 'file' });
    if (accept) input.setAttribute('accept', accept);
    if (multiple) input.multiple = true;
    if (folder) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', function () {
      var files = Array.prototype.map.call(input.files, function (f) { return { file: f, path: f.webkitRelativePath || f.name }; });
      if (!files.length) return done(null);
      uploadFiles(tab, area, files, single).then(done, function (e) { setStatus(tab, e.message, 'bad'); done(null); });
    });
    input.click();
  });
}
function acceptOf(filter) {
  return (filter || '').split('|').filter(function (_, i) { return i % 2 === 1; }).join(';').split(';').map(function (p) { return p.replace('*', ''); }).filter(function (p) { return p && p !== '.*'; }).join(',');
}
function fileField(tab, f, kind) {
  var input = el('input', { type: 'text', id: key(tab, f.id), placeholder: kind === 'folder' ? 'Folder path' : 'File path', spellcheck: 'false' });
  input.value = settings[key(tab, f.id)] || '';
  input.addEventListener('change', function () { remember(tab, f.id, input.value.trim()); visible(tab, specOf(tab)); });
  var browse = el('button', { type: 'button', text: 'Browse...', onclick: function () {
    pickPaths(kind, f.filter, false, input.value ? input.value.replace(/[\\\\\\/][^\\\\\\/]*$/, '') : '').then(function (r) {
      if (r.unsupported) return browserPick(tab, 'opt', acceptOf(f.filter), kind === 'folder', false, true).then(function (p) { if (p) { input.value = p; input.dispatchEvent(new Event('change')); } });
      if (r.paths && r.paths.length) { input.value = r.paths[0]; input.dispatchEvent(new Event('change')); }
    }).catch(function (e) { setStatus(tab, e.message, 'bad'); });
  } });
  var clear = el('button', { type: 'button', text: 'Clear', onclick: function () { input.value = ''; input.dispatchEvent(new Event('change')); } });
  return el('div', { class: 'pathline' }, [input, browse, clear]);
}
function drawParams(tab, f, message) {
  var box = $('params-' + tab);
  if (!box) return;
  box.innerHTML = '';
  var list = state[tab].params || [];
  var chosen = settings[key(tab, f.id)] || {};
  if (!list.length) { box.appendChild(el('div', { class: 'help', text: message || 'Pick reports first: their parameters are listed here.' })); return; }
  var grid = el('div', { class: 'params' });
  list.forEach(function (p) {
    var on = chosen[p.name] !== undefined && chosen[p.name] !== null;
    var tick = el('input', { type: 'checkbox' });
    tick.checked = on;
    var pickValue = el('select', {});
    p.values.forEach(function (v) { pickValue.appendChild(el('option', { value: v, text: v })); });
    if (on && p.values.indexOf(chosen[p.name]) >= 0) pickValue.value = chosen[p.name];
    pickValue.disabled = !on;
    var save = function () {
      var next = Object.assign({}, settings[key(tab, f.id)] || {});
      if (tick.checked) next[p.name] = pickValue.value; else delete next[p.name];
      pickValue.disabled = !tick.checked;
      remember(tab, f.id, next);
    };
    tick.addEventListener('change', save);
    pickValue.addEventListener('change', save);
    var title = p.name + (p.prompt && p.prompt !== p.name ? ' (' + p.prompt + ')' : '');
    grid.appendChild(el('label', { class: 'pname', title: 'Used in ' + p.reports + ' report(s)' }, [tick, title]));
    grid.appendChild(pickValue);
  });
  box.appendChild(grid);
}
function loadParams(tab) {
  var spec = specOf(tab);
  var f = null;
  spec.groups.forEach(function (g) { g.fields.forEach(function (x) { if (x.type === 'params') f = x; }); });
  if (!f) return;
  var st = state[tab];
  if (!st.inputs.length) { st.params = []; return drawParams(tab, f); }
  drawParams(tab, f, 'Reading the parameters of the picked reports...');
  api('parameters', { json: { paths: st.inputs } }).then(function (r) {
    st.params = r.parameters;
    drawParams(tab, f, r.files ? 'None of the picked reports has a parameter that decides what is shown or hidden: nothing to fix.' : 'No reports found in what was picked.');
  }).catch(function (e) { drawParams(tab, f, 'Could not read the parameters: ' + e.message); });
}
function field(tab, f) {
  var id = key(tab, f.id);
  var saved = settings[id];
  var control;
  if (f.type === 'file' || f.type === 'folder') control = fileField(tab, f, f.type);
  else if (f.type === 'params') {
    control = el('div', {}, [el('div', { id: 'params-' + tab }), el('button', { type: 'button', text: 'Read again from the picked reports', style: 'margin-top:8px', onclick: function () { loadParams(tab); } })]);
  } else if (f.type === 'check') {
    var box = el('input', { type: 'checkbox', id: id });
    box.checked = !!saved;
    box.addEventListener('change', function () { remember(tab, f.id, box.checked); visible(tab, specOf(tab)); });
    control = el('label', { class: 'check', for: id }, [box, el('span', {}, [el('span', { text: f.help || '' })])]);
    return el('div', { class: 'row', id: 'row-' + id }, [el('label', { for: id, text: f.label }), control]);
  } else if (f.type === 'select') {
    control = el('select', { id: id });
    f.options.forEach(function (o) { control.appendChild(el('option', { value: o[0], text: o[1] })); });
    control.value = saved !== undefined ? saved : f.options[0][0];
    control.addEventListener('change', function () { remember(tab, f.id, control.value); visible(tab, specOf(tab)); });
  } else {
    control = el(f.type === 'textarea' ? 'textarea' : 'input', { id: id, spellcheck: 'false' });
    if (f.type !== 'textarea') control.setAttribute('type', 'text');
    if (f.placeholder) control.setAttribute('placeholder', f.placeholder);
    if (f.type === 'number') { control.setAttribute('inputmode', 'numeric'); control.setAttribute('style', 'max-width:200px'); control.addEventListener('input', function () { control.value = control.value.replace(/[^0-9-]/g, ''); }); }
    control.value = saved !== undefined ? saved : (f.value || '');
    control.addEventListener('change', function () { remember(tab, f.id, control.value); });
  }
  var help = f.help && f.type !== 'check' ? el('div', { class: 'help', text: f.help }) : null;
  return el('div', { class: 'row', id: 'row-' + id }, [el('label', { for: id, text: f.label }), el('div', {}, [control, help])]);
}
function specOf(tab) { return TABS.filter(function (t) { return t.id === tab; })[0]; }
function showInputs(tab) {
  var st = state[tab];
  var box = $('chips-' + tab);
  box.innerHTML = '';
  st.inputs.forEach(function (p, i) {
    box.appendChild(el('span', { class: 'chip', title: p }, [p, el('b', { title: 'Remove', text: 'x', onclick: function () { st.inputs.splice(i, 1); remember(tab, 'inputs', st.inputs); showInputs(tab); loadParams(tab); } })]));
  });
  $('none-' + tab).classList.toggle('hidden', st.inputs.length > 0);
}
function setInputs(tab, paths, add) {
  var st = state[tab];
  var spec = specOf(tab);
  st.inputs = spec.input.single ? paths.slice(0, 1) : (add ? st.inputs.concat(paths.filter(function (p) { return st.inputs.indexOf(p) < 0; })) : paths);
  remember(tab, 'inputs', st.inputs);
  showInputs(tab);
  loadParams(tab);
}
function readEntries(entry, prefix, out) {
  if (entry.isFile) return new Promise(function (done) { entry.file(function (f) { out.push({ file: f, path: prefix + f.name }); done(); }, function () { done(); }); });
  if (!entry.isDirectory) return Promise.resolve();
  var reader = entry.createReader();
  return new Promise(function (done) {
    var all = [];
    (function more() {
      reader.readEntries(function (batch) {
        if (!batch.length) return Promise.all(all.map(function (e) { return readEntries(e, prefix + entry.name + '/', out); })).then(function () { done(); });
        all = all.concat(Array.prototype.slice.call(batch));
        more();
      }, function () { done(); });
    })();
  });
}
function inputCard(tab, spec) {
  var none = el('div', { class: 'help', id: 'none-' + tab, text: 'Nothing picked yet.' });
  var chips = el('div', { class: 'chips', id: 'chips-' + tab });
  var files = el('button', { type: 'button', text: spec.input.single ? 'Choose file...' : 'Add files...', onclick: function () {
    pickPaths('file', spec.input.filter, !spec.input.single).then(function (r) {
      if (r.unsupported) return browserPick(tab, 'in', acceptOf(spec.input.filter), false, !spec.input.single, !!spec.input.single).then(function (p) { if (p) setInputs(tab, [p]); });
      if (r.paths && r.paths.length) setInputs(tab, r.paths, !spec.input.single);
    }).catch(function (e) { setStatus(tab, e.message, 'bad'); });
  } });
  var folder = spec.input.single ? null : el('button', { type: 'button', text: 'Add folder...', onclick: function () {
    pickPaths('folder', '', false).then(function (r) {
      if (r.unsupported) return browserPick(tab, 'in', '', true, false, false).then(function (p) { if (p) setInputs(tab, [p]); });
      if (r.paths && r.paths.length) setInputs(tab, r.paths, true);
    }).catch(function (e) { setStatus(tab, e.message, 'bad'); });
  } });
  var clear = el('button', { type: 'button', text: 'Clear list', onclick: function () { setInputs(tab, []); } });
  var paste = el('input', { type: 'text', placeholder: 'or paste a file or folder path and press Enter', spellcheck: 'false' });
  paste.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || !paste.value.trim()) return;
    var p = paste.value.trim().replace(/^"|"$/g, '');
    api('exists', { json: { paths: [p] } }).then(function (r) {
      if (r[p] === 'missing') return setStatus(tab, 'Not found: ' + p, 'bad');
      setInputs(tab, [p], !spec.input.single); paste.value = ''; setStatus(tab, '', '');
    });
  });
  var drop = el('div', { class: 'drop', text: 'or drop ' + (spec.input.single ? 'a file' : 'files or a folder') + ' here' });
  drop.addEventListener('dragover', function (ev) { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (ev) {
    ev.preventDefault(); drop.classList.remove('over');
    var out = [];
    var items = Array.prototype.slice.call(ev.dataTransfer.items || []);
    Promise.all(items.map(function (it) { var e = it.webkitGetAsEntry && it.webkitGetAsEntry(); return e ? readEntries(e, '', out) : Promise.resolve(); })).then(function () {
      out = out.filter(function (f) { return spec.input.ext.test(f.path); });
      if (!out.length) return setStatus(tab, 'Nothing to use in what was dropped.', 'bad');
      uploadFiles(tab, 'in', spec.input.single ? out.slice(0, 1) : out, !!spec.input.single).then(function (p) { setInputs(tab, [p]); }, function (e) { setStatus(tab, e.message, 'bad'); });
    });
  });
  return el('div', { class: 'card' }, [el('h3', { text: spec.input.label }), el('div', { class: 'actions' }, [files, folder, clear]), chips, none, el('div', { style: 'margin-top:8px' }, [paste]), drop]);
}
function outputCard(tab) {
  var f = { id: 'output', type: 'folder', label: 'Save results to', help: 'Results are copied here after each run, keeping subfolders. Leave empty to only download them.' };
  if (settings[key(tab, 'output')] === undefined && state.home) settings[key(tab, 'output')] = state.home + (WINDOWS ? '\\\\Documents\\\\Report Converter\\\\' : '/Report Converter/') + specOf(tab).title.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return el('div', { class: 'card' }, [el('h3', { text: 'Results' }), field(tab, f)]);
}
function setStatus(tab, msg, kind) {
  var s = $('status-' + tab);
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}
function addLog(tab, lines) {
  var log = $('log-' + tab);
  log.classList.remove('hidden');
  lines.forEach(function (line) {
    var cls = /^(FAIL|Error)/.test(line) ? 'f' : /^(OK|Saved|All |CHECK .*: clean)/.test(line) ? 'o' : /^(NOTE|CHECK)/.test(line) ? 'n' : '';
    log.appendChild(el('span', { class: cls, text: line + '\\n' }));
  });
  log.scrollTop = log.scrollHeight;
}
function fileUrl(job, path, download) {
  return '/api/file?t=' + TOKEN + '&job=' + job + (download ? '&download=1' : '') + '&path=' + encodeURIComponent(path);
}
function showFiles(tab, files, savedTo) {
  var st = state[tab];
  var box = $('files-' + tab);
  box.innerHTML = '';
  if (!files.length) return;
  var head = el('div', { class: 'actions', style: 'margin-top:12px' }, [
    el('strong', { text: files.length + ' file(s) written' }),
    el('button', { type: 'button', text: 'Download all (.zip)', onclick: function () { location.href = '/api/zip?t=' + TOKEN + '&job=' + st.job + '&name=' + encodeURIComponent(specOf(tab).title); } }),
    savedTo ? el('button', { type: 'button', text: 'Open folder', onclick: function () { api('open', { json: { path: savedTo } }).catch(function (e) { setStatus(tab, e.message, 'bad'); }); } }) : null,
    savedTo ? el('span', { class: 'help', text: 'Saved to ' + savedTo }) : null ]);
  var table = el('table', { class: 'files' });
  files.slice(0, 500).forEach(function (f) {
    var view = /\\.html$/i.test(f) ? el('a', { text: 'Open', href: fileUrl(st.job, f), target: '_blank', rel: 'noopener' })
      : /\\.(txt|md|sql|vb|csv|json|rdl)$/i.test(f) ? el('a', { text: 'View', onclick: function () { viewFile(st.job, f); } }) : null;
    var dl = el('a', { text: 'Download', href: fileUrl(st.job, f, true) });
    table.appendChild(el('tr', {}, [el('td', { text: f }), el('td', {}, [view, view ? ' \\u00a0 ' : null, dl])]));
  });
  box.appendChild(head);
  box.appendChild(table);
  if (files.length > 500) box.appendChild(el('div', { class: 'help', text: 'Showing the first 500. Download all to get every file.' }));
}
function viewFile(job, path) {
  fetch(fileUrl(job, path)).then(function (r) { return r.text(); }).then(function (t) {
    $('viewer-name').textContent = path;
    $('viewer-text').textContent = t.length > 2000000 ? t.slice(0, 2000000) + '\\n... (cut: download the file to see all of it)' : t;
    $('viewer').classList.add('on'); $('shade').classList.add('on');
  });
}
function hideViewer() { $('viewer').classList.remove('on'); $('shade').classList.remove('on'); }
function run(tab) {
  var spec = specOf(tab);
  var st = state[tab];
  if (!st.inputs.length) return setStatus(tab, 'Choose the ' + spec.input.label.toLowerCase() + ' first.', 'bad');
  var options = {};
  spec.groups.forEach(function (g) { g.fields.forEach(function (f) {
    var row = $('row-' + key(tab, f.id));
    if (row && !row.classList.contains('hidden')) options[f.id] = valueOf(tab, f);
  }); });
  var command = spec.commandField ? options[spec.commandField] : spec.command;
  var log = $('log-' + tab);
  log.innerHTML = '';
  $('files-' + tab).innerHTML = '';
  $('go-' + tab).disabled = true;
  setStatus(tab, 'Working...', 'run');
  var from = 0;
  api('run', { json: { job: st.job, command: command, inputs: st.inputs, output: valueOf(tab, { id: 'output', type: 'folder' }), options: options } }).then(function () {
    (function poll() {
      api('job?id=' + st.job + '&from=' + from).then(function (r) {
        if (r.log.length) addLog(tab, r.log);
        from = r.total;
        if (r.running) { setStatus(tab, 'Working... ' + r.seconds + ' s', 'run'); return setTimeout(poll, 600); }
        $('go-' + tab).disabled = false;
        var failed = r.code !== 0;
        var word = command === 'compare' ? (failed ? 'Differences found' : 'All values match') : (failed ? 'Finished with problems' : 'Done');
        setStatus(tab, word + ' in ' + r.seconds + ' s', failed ? 'bad' : 'ok');
        showFiles(tab, r.files, r.savedTo);
      }).catch(function (e) { $('go-' + tab).disabled = false; setStatus(tab, e.message, 'bad'); });
    })();
  }).catch(function (e) { $('go-' + tab).disabled = false; setStatus(tab, e.message, 'bad'); });
}
function build() {
  var nav = $('nav');
  var mainEl = $('main');
  TABS.forEach(function (spec, i) {
    var tab = spec.id;
    state[tab].inputs = (settings[key(tab, 'inputs')] || []).slice();
    nav.appendChild(el('button', { type: 'button', id: 'nav-' + tab, onclick: function () { show(tab); } }, [spec.title, el('small', { text: spec.small })]));
    var groups = spec.groups.map(function (g) { return el('div', { class: 'card' }, [el('h3', { text: g.title })].concat(g.fields.map(function (f) { return field(tab, f); }))); });
    var runCard = el('div', { class: 'card' }, [
      el('div', { class: 'actions' }, [el('button', { type: 'button', class: 'primary', id: 'go-' + tab, text: tab === 'compare' ? 'Check data' : 'Run', onclick: function () { run(tab); } }), el('span', { class: 'status', id: 'status-' + tab })]),
      el('pre', { class: 'log hidden', id: 'log-' + tab }),
      el('div', { id: 'files-' + tab }) ]);
    var section = el('section', { id: 'tab-' + tab, class: i ? 'hidden' : '' }, [el('h2', { text: spec.title }), el('p', { class: 'blurb', text: spec.blurb }), inputCard(tab, spec)].concat(groups, [outputCard(tab), runCard]));
    mainEl.appendChild(section);
    showInputs(tab);
    visible(tab, spec);
  });
  show(settings.tab || 'convert');
  var all = [];
  TABS.forEach(function (t) { all = all.concat(state[t.id].inputs); });
  var after = function () { TABS.forEach(function (t) { loadParams(t.id); }); };
  if (all.length) api('exists', { json: { paths: all } }).then(function (found) {
    TABS.forEach(function (t) {
      var kept = state[t.id].inputs.filter(function (p) { return found[p] && found[p] !== 'missing'; });
      if (kept.length !== state[t.id].inputs.length) { state[t.id].inputs = kept; remember(t.id, 'inputs', kept); showInputs(t.id); }
    });
    after();
  }).catch(after);
  else after();
}
function show(tab) {
  if (!specOf(tab)) tab = 'convert';
  TABS.forEach(function (t) { $('tab-' + t.id).classList.toggle('hidden', t.id !== tab); $('nav-' + t.id).classList.toggle('on', t.id === tab); });
  if (settings.tab !== tab) remember('', 'tab', tab);
}
function quit() {
  if (!confirm('Stop Report Converter? Any results not saved or downloaded are removed.')) return;
  api('quit', { method: 'POST' }).finally(function () { $('gone').style.display = 'flex'; });
}
function start() {
  api('settings').then(function (s) { settings = s || {}; }).catch(function () {}).then(function () {
    return Promise.all(TABS.map(function (t) { return api('job', { method: 'POST' }).then(function (r) { state[t.id] = { job: r.id, inputs: [], params: [] }; state.home = r.home; }); }));
  }).then(build).catch(function (e) { document.body.textContent = 'Could not start: ' + e.message; });
  setInterval(function () { api('ping').catch(function () {}); }, 20000);
}
document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideViewer(); });
start();
`;

export function page(token: string, windows: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report Converter</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http:\/\/www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='4' y='2' width='24' height='28' rx='3' fill='%231f6feb'/%3E%3Cpath d='M9 10h14M9 15h14M9 20h9' stroke='white' stroke-width='2.4'/%3E%3C/svg%3E">
<style>${STYLE}</style>
</head>
<body>
<header><h1>Report Converter</h1><span class="sub">.rpt to SSRS .rdl, on this computer only</span><span class="grow"></span><button type="button" onclick="quit()">Quit</button></header>
<div class="wrap"><nav id="nav"></nav><main id="main"></main></div>
<div class="shade" id="shade" onclick="hideViewer()"></div>
<div class="viewer" id="viewer"><div class="bar"><span id="viewer-name"></span><button type="button" onclick="hideViewer()">Done</button></div><pre id="viewer-text"></pre></div>
<div class="gone" id="gone">Report Converter has stopped. You can leave this tab.</div>
<script>${SCRIPT.replace('__TOKEN__', token).replace('__WINDOWS__', windows ? 'true' : 'false')}</script>
</body>
</html>`;
}

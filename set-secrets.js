/**
 * 用 GitHub API 写入 Actions Secrets（libsodium sealed box 加密）
 */
const fs = require('fs');
const sodium = require('libsodium-wrappers');

const TOKEN = process.argv[2];
const REPO = 'WT1013/ecom-ai-workbench-kb';
const W = 'E:/wkbd/2026-11-05-12-00-36/work/';

const st = JSON.parse(fs.readFileSync(W + 'kb-cookies.json', 'utf8'));
const cookie = (st.cookies || []).map(c => c.name + '=' + c.value).join('; ');

const SECRETS = {
  TANYU_COOKIE: cookie,
  WB_ENDPOINT: 'https://ecom-ai-workbench-51738.app.workbuddy.host',
  WB_KEY: 'wbpk_t8gGa4NdI6uP7HoLcOCVRL_gN9jzV2uJ7Glxfq0co2iPs4lSCbtckmO',
  WB_SHARECODE: 'X2H6EJOS4A',
};

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wb-worker',
};

(async () => {
  await sodium.ready;
  const kr = await fetch('https://api.github.com/repos/' + REPO + '/actions/secrets/public-key', { headers: H });
  const key = await kr.json();
  if (!key.key) throw new Error('拿不到 public key: ' + JSON.stringify(key).slice(0, 200));
  console.log('public key id', key.key_id);

  const bin = sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL);

  for (const [name, value] of Object.entries(SECRETS)) {
    const enc = sodium.crypto_box_seal(sodium.from_string(value), bin);
    const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/secrets/' + name, {
      method: 'PUT',
      headers: Object.assign({ 'content-type': 'application/json' }, H),
      body: JSON.stringify({ encrypted_value: sodium.to_base64(enc, sodium.base64_variants.ORIGINAL), key_id: key.key_id }),
    });
    console.log(name, r.status, r.status === 201 || r.status === 204 ? 'OK' : (await r.text()).slice(0, 120));
  }

  const lr = await fetch('https://api.github.com/repos/' + REPO + '/actions/secrets', { headers: H });
  const lj = await lr.json();
  console.log('已配置：', (lj.secrets || []).map(s => s.name).join(', '));
})();

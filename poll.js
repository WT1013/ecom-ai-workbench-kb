const TOKEN = process.argv[2];
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'wb' };
const REPO = 'WT1013/ecom-ai-workbench-kb';

(async () => {
  let last = null;
  for (let i = 0; i < 40; i++) {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?per_page=1', { headers: H });
    const j = await r.json();
    const x = (j.workflow_runs || [])[0];
    if (x) {
      if (x.id !== last) { console.log('RUN', x.id, x.status, x.created_at); last = x.id; }
      else console.log(i, x.status);
      if (x.status === 'completed') {
        console.log('CONCLUSION', x.conclusion);
        const jr = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs/' + x.id + '/jobs', { headers: H });
        const jj = await jr.json();
        const lr = await fetch('https://api.github.com/repos/' + REPO + '/actions/jobs/' + jj.jobs[0].id + '/logs', { headers: { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'wb' }, redirect: 'follow' });
        const txt = await lr.text();
        const lines = txt.split('\n').filter(l => /卡片|ERR|OK 20|新增|修改|删除|重试|页=|空页/.test(l));
        console.log(lines.map(l => l.replace(/^\S+Z\s*/, '')).join('\n'));
        return;
      }
    } else {
      console.log(i, 'no run yet');
    }
    await new Promise(s => setTimeout(s, 12000));
  }
  console.log('TIMEOUT');
})();

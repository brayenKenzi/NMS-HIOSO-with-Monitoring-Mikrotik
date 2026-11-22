const fs = require('node:fs');
const path = require('node:path');

const srcAssets = path.join(__dirname, '..', 'src', 'assets');
const target = path.join(__dirname, '..', 'src', 'server', 'static-assets.cjs');

const html = fs.readFileSync(path.join(srcAssets, 'dashboard.html'), 'utf8');
const ops = fs.readFileSync(path.join(srcAssets, 'operations.js'), 'utf8');
const worker = fs.readFileSync(path.join(srcAssets, 'nms-worker.js'), 'utf8');
const logo = fs.readFileSync(path.join(srcAssets, 'adt-logo.png')).toString('base64');

const content = `// Auto-generated static assets bundle
module.exports = {
  page: ${JSON.stringify(html)},
  operations: ${JSON.stringify(ops)},
  worker: ${JSON.stringify(worker)},
  logo: Buffer.from(${JSON.stringify(logo)}, 'base64'),
};
`;

fs.writeFileSync(target, content, 'utf8');
console.log('static-assets.cjs generated successfully: ' + (content.length / 1024).toFixed(1) + ' KB');

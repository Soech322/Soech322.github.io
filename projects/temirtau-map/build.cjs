const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
let template=fs.readFileSync(path.join(root,'index.template.html'),'utf8');
const read=name=>fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,'');
const mime=name=>({'.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'}[path.extname(name)]||'application/octet-stream');
const data=name=>'data:'+mime(name)+';base64,'+fs.readFileSync(path.join(root,name)).toString('base64');
const escapeScript=code=>code.replace(/<\/script/gi,'<\\/script').replace(/^\/\/# sourceMappingURL=.*$/gm,'');
function build(portable){
 let scripts=0,styles=0;
 let html=template.replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g,'');
 html=html.replace(/<link rel="manifest"[^>]*>\s*/,'');
 html=html.replace(/(?:href|src)="icon\.svg"/g,m=>m.slice(0,m.indexOf('"')+1)+data('icon.svg')+'"');
 html=html.replace(/<link rel="stylesheet" href="([^"]+)">/g,(tag,name)=>{
   if(/^https?:/.test(name))throw new Error('Unexpected external CSS: '+name);
   let css=read(name);
   css=css.replace(/url\((['"]?)(images\/[^)'"\s]+)\1\)/g,(_,quote,image)=>'url("'+data(path.posix.join(path.posix.dirname(name),image))+'")');
   css=css.replace(/^\/\*# sourceMappingURL=.*?\*\/$/gm,'');
   styles++;return '<style>\n/* Embedded: '+name+' */\n'+css.replace(/<\/style/gi,'<\\/style')+'\n</style>';
 });
 html=html.replace(/<script src="([^"]+)"><\/script>/g,(tag,name)=>{
   if(/^https?:/.test(name))throw new Error('Unexpected external script: '+name);
   let code=read(name);
   code=code.replaceAll('${location.origin}${location.pathname}',"${location.href.split('#')[0]}");
   if(portable&&name==='js/core.js'){
     const a=code.indexOf('  function registerServiceWorker() {'),b=code.indexOf('\n  function boot()',a);
     if(a<0||b<0)throw new Error('SW function not found');
     code=code.slice(0,a)+'  function registerServiceWorker() { /* Use full project for PWA installation. */ }\n'+code.slice(b);
   }
   scripts++;return '<script>\n/* Embedded: '+name+' */\n'+escapeScript(code)+'\n</script>';
 });
 if(!portable)html=html.replace('</head>',`<script>
if (/^https?:$/.test(location.protocol)) {
  const manifest = document.createElement('link');
  manifest.rel = 'manifest'; manifest.href = 'manifest.webmanifest'; document.head.appendChild(manifest);
}
</script>\n</head>`);
 if(scripts!==18||styles!==2)throw new Error('Unexpected embedded asset count: '+scripts+'/'+styles);
 return html;
}
fs.writeFileSync(path.join(root,'index.html'),build(false));
fs.writeFileSync(path.join(root,'..','КАРТА-ОТКРЫТЬ.html'),build(true));
fs.writeFileSync(path.join(root,'..','Темиртау-карта.html'),build(true));
console.log('Built index.html and КАРТА-ОТКРЫТЬ.html: 18 scripts, 2 stylesheets, embedded icons/data.');

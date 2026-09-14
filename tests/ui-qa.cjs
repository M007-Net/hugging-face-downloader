const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
(async()=>{
  const root=path.resolve(__dirname,'..');const output=process.env.HFD_QA_OUTPUT || path.join(root,'qa-output');fs.mkdirSync(output,{recursive:true});
  const env={...process.env,HFD_QA:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[root,'--disable-gpu','--disable-gpu-compositing','--in-process-gpu'],env});
  try {
    const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.getByRole('heading',{name:'Download a model from Hugging Face'}).waitFor();
    await page.screenshot({path:path.join(output,'01-welcome.png')});
    // The default download folder sits under the current user's profile, which
    // would put a real home directory into every screenshot from here on. Point
    // it somewhere neutral first so the captures are publishable.
    await page.locator('nav').getByRole('button',{name:'Settings'}).click();
    await page.locator('#setting-output').fill('D:\\AI\\models');
    await page.getByRole('button',{name:'Save settings'}).click();
    await page.getByText('Settings saved on this computer.',{exact:false}).waitFor();
    await page.locator('nav').getByRole('button',{name:'New download'}).click();
    await page.locator('#repo').waitFor();
    await page.locator('#repo').fill('unsloth/gemma-4-31B-it-GGUF');await page.getByRole('button',{name:'Load model',exact:true}).click();
    await page.locator('#bit').waitFor();
    await page.locator('#bit').selectOption('3');
    assert.ok((await page.locator('#quant').inputValue()).includes('3'));
    await page.locator('[data-companion="vision"]').check();await page.locator('[data-companion="mtp"]').check();
    assert.equal(await page.locator('[data-extra="mtp"] option').count(),4);
    await page.getByText('Review selected files',{exact:true}).click();
    await page.screenshot({path:path.join(output,'02-quantization.png'),fullPage:true});
    assert.ok(await page.locator('#download').isEnabled());
    await page.getByRole('button',{name:'Choose specific files'}).click();
    await page.locator('#file-search').fill('BF16/gemma');
    await page.locator('[data-file]').first().check();
    assert.equal(await page.locator('[data-file]:checked').count(),2);
    await page.screenshot({path:path.join(output,'03-files.png'),fullPage:true});
    await page.locator('nav').getByRole('button',{name:'Settings'}).click();
    await page.locator('#setting-connections').fill('8');await page.locator('#setting-quant').fill('IQ3_XXS');
    await page.getByRole('button',{name:'Save settings'}).click();await page.getByText('Settings saved on this computer.',{exact:false}).waitFor();
    assert.equal(await page.locator('#setting-connections').inputValue(),'8');
    // The detected-aria2 line reports a real path, which on most machines sits
    // under the current user's profile. Neutralize it for the same reason the
    // download folder was changed above: these captures are meant to be
    // publishable. Nothing re-renders between here and the screenshot.
    await page.evaluate(()=>{for(const el of document.querySelectorAll('small.field-note'))if(el.textContent.startsWith('Detected: '))el.textContent='Detected: C:\\Tools\\aria2\\aria2c.exe';});
    await page.screenshot({path:path.join(output,'04-settings.png'),fullPage:true});
    await page.locator('nav').getByRole('button',{name:'Downloads'}).click();
    await page.getByRole('heading',{name:'No downloads yet'}).waitFor();
    await page.screenshot({path:path.join(output,'05-downloads.png')});
    await page.locator('nav').getByRole('button',{name:'New download'}).click();
    await page.locator('#repo').fill('https://example.com/wrong');await page.getByRole('button',{name:'Load model',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Use a link from huggingface.co.'}).waitFor();
    assert.equal(await page.locator('#download').count(),0);
    await page.setViewportSize({width:1000,height:760});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal overflow at minimum width');
    assert.deepEqual(errors,[]);
    console.log('PASS: desktop UI flow, settings, split selection, error state, and minimum-width checks.');
  } finally {await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

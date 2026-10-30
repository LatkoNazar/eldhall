import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mode = 'tutorial';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localSource = (value) => {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Source must be inside this bundle: ${value}`);
  return resolved;
};
const definition = JSON.parse(await fs.readFile(path.join(root, 'scenes', `${mode}.json`), 'utf8'));
const canvas = {width: definition.width || 1920, height: definition.height || 1080};
const locale = JSON.parse(await fs.readFile(path.join(root, 'locales', `${definition.locale}.json`), 'utf8'));
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const probe = (file) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate', '-of', 'json', file], {encoding: 'utf8'}));
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const srtSeconds = (stamp) => {const [h,m,s,ms] = stamp.split(/[:,]/).map(Number); return h*3600+m*60+s+ms/1000;};
const srtStamp = (seconds) => {const n=Math.round(seconds*1000);const pad=(value,length=2)=>String(value).padStart(length,'0');return `${pad(Math.floor(n/3600000))}:${pad(Math.floor(n/60000)%60)}:${pad(Math.floor(n/1000)%60)},${pad(n%1000,3)}`;};
await fs.mkdir(path.join(root, 'assets', 'video'), {recursive: true});
await fs.mkdir(path.join(root, 'assets', 'audio'), {recursive: true});
await fs.mkdir(path.join(root, 'assets', 'vendor'), {recursive: true});
await fs.mkdir(path.join(root, 'renders'), {recursive: true});
await fs.mkdir(path.join(root, 'compositions'), {recursive: true});
await fs.copyFile(path.join(root, 'node_modules', 'gsap', 'dist', 'gsap.min.js'), path.join(root, 'assets', 'vendor', 'gsap.min.js'));

const scenes = [];
const ledger = [];
const subtitles = [];
let duration = 0;
for (const sourceScene of definition.scenes) {
  const scene = {...sourceScene, start: duration};
  if (scene.source) {
    const original = localSource(scene.source);
    await fs.access(original);
    const info = probe(original);
    const videoStream = info?.streams?.find((stream) => stream.width);
    if (videoStream && (videoStream.width !== canvas.width || videoStream.height !== canvas.height)) throw new Error(`Source canvas mismatch for ${scene.id}: ${videoStream.width}x${videoStream.height}, expected ${canvas.width}x${canvas.height}.`);
    scene.mediaStart = scene.mediaStart || 0;
    scene.duration = scene.duration || (Number(info.format.duration) - scene.mediaStart);
    scene.source = `assets/video/${scene.id}.mp4`;
    if (original !== path.join(root, scene.source)) await fs.copyFile(original, path.join(root, scene.source));
    ledger.push({id: scene.id, source: sourceScene.source, local: scene.source, sha256: crypto.createHash('sha256').update(await fs.readFile(original)).digest('hex'), mediaStart: scene.mediaStart, playbackRate: 1, cursor: 'live co-recorded pointer baked into the same source frames; no renderer cursor', sourceStreams: info.streams});
  }
  if (scene.audio) {
    const original = localSource(scene.audio);
    await fs.access(original);
    scene.audio = `assets/audio/${scene.id}.mp3`;
    if (original !== path.join(root, scene.audio)) await fs.copyFile(original, path.join(root, scene.audio));
    scene.audioDuration = Number(probe(original).format.duration);
    if (scene.audioStart + scene.audioDuration > scene.duration + 0.02) throw new Error(`Narration extends past ${scene.id}; adjust the scene's actual source hold or narration placement.`);
    const sourceSrt = original.replace(/\.mp3$/i, '.srt');
    try {
      const text = await fs.readFile(sourceSrt, 'utf8');
      await fs.writeFile(path.join(root, 'assets', 'audio', `${scene.id}.srt`), text);
      for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
        const lines=block.split(/\r?\n/);const timing=lines.findIndex((line)=>line.includes(' --> '));
        if(timing<0) continue;
        const [a,b]=lines[timing].split(' --> ');const offset=scene.start+scene.audioStart;
        subtitles.push({start:srtSeconds(a)+offset,end:srtSeconds(b)+offset,text:lines.slice(timing+1).join('\n')});
      }
    } catch (error) {if(error.code!=='ENOENT') throw error;}
  }
  if (!(scene.duration > 0)) throw new Error(`No positive duration for ${scene.id}`);
  // ffprobe rounds rational CFR durations to six decimals; avoid adding a spurious frame.
  scene.duration = Math.ceil(scene.duration * definition.fps - 0.0001) / definition.fps;
  duration += scene.duration;
  scenes.push(scene);
}
duration = Math.round(duration * definition.fps) / definition.fps;
const config = {...definition, ...canvas, duration, scenes};
const tags = [];
for (const scene of scenes) {
  const text = locale[scene.id] || '';
  const video = scene.type === 'capture' ? `<video id="${scene.id}-video" class="clip footage" data-start="${scene.start}" data-duration="${scene.duration}" data-media-start="${scene.mediaStart || 0}" data-playback-rate="1" data-track-index="0" src="${scene.source}" muted playsinline></video>` : '';
  const graphicsId = `${scene.id}-graphics`;
  const labelStart = scene.type === 'capture' ? scene.labelStart : 0;
  const labelDuration = scene.type === 'capture' ? scene.labelDuration : scene.duration;
  const target = `${scene.id}-motion`;
  const entranceOpacity = scene.type === 'capture' ? 0 : 1;
  const graphic = scene.type === 'capture' ? `<div id="${target}" class="label-motion ${scene.id}" data-layout-allow-overlap>${escape(text)}</div>` : `<div id="${target}" class="title-card"><div class="wordmark">${escape(locale.brand)}</div><h1>${escape(locale[`${scene.id}Title`])}</h1><p>${escape(locale[`${scene.id}Subtitle`])}</p>${scene.id === 'outro' ? `<div class="credit">${escape(locale.credit)}</div>` : ''}</div>`;
  const subcomposition = `<template>\n<style>#root{position:absolute;inset:0;font-family:'Segoe UI',Arial,sans-serif;}</style>\n<div id="root" data-composition-id="${graphicsId}" data-width="${canvas.width}" data-height="${canvas.height}" data-fps="${definition.fps}"><div id="${scene.id}-graphic" class="clip chapter" data-start="${labelStart}" data-duration="${labelDuration}" data-track-index="1">${graphic}</div></div>\n<script>const tl=gsap.timeline({paused:true});tl.to({}, {duration:${scene.duration},ease:'none'},0);tl.fromTo('#${target}',{opacity:${entranceOpacity},y:8},{opacity:1,y:0,duration:.2,ease:'power2.out'},${labelStart});tl.fromTo('#${target}',{opacity:1,y:0},{opacity:0,y:-4,duration:.2,ease:'power2.in',immediateRender:false},${labelStart + labelDuration - 0.2});window.__timelines=window.__timelines||{};window.__timelines['${graphicsId}']=tl;</script>\n</template>\n`;
  await fs.writeFile(path.join(root, 'compositions', `${graphicsId}.html`), subcomposition);
  const label = `<div id="${graphicsId}" class="clip" data-composition-id="${graphicsId}" data-composition-src="compositions/${graphicsId}.html" data-start="${scene.start}" data-duration="${scene.duration}" data-track-index="1" data-track-kind="graphics" data-width="${canvas.width}" data-height="${canvas.height}"></div>`;
  const audio = scene.audio ? `<audio id="${scene.id}-voice" data-start="${scene.start + scene.audioStart}" data-duration="${scene.audioDuration}" data-track-index="2" src="${scene.audio}" data-volume="1.412538" ></audio>` : '';
  tags.push(...[video, label, audio].filter(Boolean).map((tag) => `    ${tag}`));
}
const html = `<!doctype html>\n<html lang="uk" style="--canvas-width:${canvas.width}px;--canvas-height:${canvas.height}px">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=${canvas.width},height=${canvas.height}">\n  <link rel="stylesheet" href="styles.css">\n  <script src="assets/vendor/gsap.min.js"></script>\n</head>\n<body>\n  <main id="root" data-composition-id="${definition.id}" data-start="0" data-duration="${duration}" data-width="${canvas.width}" data-height="${canvas.height}" data-fps="${definition.fps}">\n${tags.join('\n')}\n  </main>\n  <script id="demo-config" type="application/json">${JSON.stringify(config)}</script>\n  <script src="main.js"></script>\n  <script>window.__timelines=window.__timelines||{};window.__timelines['${definition.id}']=window.buildRootTimeline(${duration});</script>\n</body>\n</html>\n`;
await fs.writeFile(path.join(root, 'index.html'), html);
await fs.writeFile(path.join(root, 'scene-timing.json'), JSON.stringify(config, null, 2));
await fs.writeFile(path.join(root, 'assets', 'ledger.json'), JSON.stringify(ledger, null, 2));
if(subtitles.length) await fs.writeFile(path.join(root,'renders','youtube-reference-uk-60fps.srt'),subtitles.map((cue,index)=>`${index+1}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${cue.text}\n`).join('\n'));
console.log(`Built ${definition.id}: ${duration}s at ${definition.fps}fps; ${scenes.length} scenes, live co-recorded cursor, all playback at 1x.`);

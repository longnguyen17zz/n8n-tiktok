import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

/**
 * Đảm bảo file video có audio stream.
 * Nếu Google Vids xuất clip không có tiếng, tự động chèn luồng silent stereo 48kHz (-c:v copy trong vài ms)
 */
async function ensureAudioStream(filePath, tmpDir, index) {
  try {
    const probeCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=nw=1:nk=1 "${filePath}"`;
    const { stdout } = await execPromise(probeCmd);
    if (stdout.trim().length > 0) {
      return filePath; // Đã có audio stream
    }
  } catch (e) {}

  const normPath = path.join(tmpDir, `norm_clip_${index}.mp4`);
  const muxCmd = `ffmpeg -y -i "${filePath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 -c:v copy -c:a aac -b:a 192k -shortest "${normPath}"`;
  await execPromise(muxCmd);
  return normPath;
}

export async function mergeVideosWithFfmpeg(clipFiles, logoPath, outputFinal) {
  if (!clipFiles || clipFiles.length === 0) throw new Error('Không có clip nào để ghép');

  const tmpDir = path.resolve(`temp/ffmpeg_work_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Chuẩn hóa tất cả các clip để chắc chắn có cả Video và Audio stream hợp lệ
    const readyClips = [];
    for (let i = 0; i < clipFiles.length; i++) {
      const ready = await ensureAudioStream(clipFiles[i], tmpDir, i);
      readyClips.push(ready);
    }

    const rawVideo = path.join(tmpDir, 'merged_raw.mp4');
    const durList = [];

    const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${readyClips[0]}"`;
    const { stdout: sizeOut } = await execPromise(probeCmd);
    const [targetW, targetH] = sizeOut.trim().split('x');

    for (let i = 0; i < readyClips.length; i++) {
      const f = readyClips[i];
      const durCmd = `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`;
      const { stdout } = await execPromise(durCmd);
      durList.push({ file: f, dur: parseFloat(stdout.trim()) || 2.0 });
    }

    const FPS = 30;
    const TRANSITION = 0.35;
    const TRIM_EDGE = 0.15;
    const SPEED = 1.1;

    let inputArgs = readyClips.map(f => `-i "${f}"`).join(' ');
    let filter = '';
    let cumulative = 0;

    durList.forEach((item, idx) => {
      let startTrim = 0;
      let endTrim = item.dur;
      let effDur = item.dur;

      if (durList.length > 1) {
        if (idx === 0) {
          endTrim = Math.max(0.3, item.dur - TRIM_EDGE);
          effDur = endTrim;
        } else if (idx === durList.length - 1) {
          startTrim = TRIM_EDGE;
          effDur = Math.max(0.3, item.dur - TRIM_EDGE);
        } else {
          startTrim = TRIM_EDGE;
          endTrim = Math.max(0.3, item.dur - TRIM_EDGE);
          effDur = Math.max(0.3, item.dur - (2 * TRIM_EDGE));
        }
      }

      filter += `[${idx}:v]trim=start=${startTrim}:end=${endTrim},setpts=PTS-STARTPTS,fps=${FPS},scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=1/90000[v${idx}];`;
      filter += `[${idx}:a]atrim=start=${startTrim}:end=${endTrim},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${idx}];`;

      if (idx === 0) cumulative = effDur;
    });

    if (durList.length === 1) {
      filter += `[v0]format=yuv420p[vout];[a0]anull[aout]`;
    } else {
      for (let i = 1; i < durList.length; i++) {
        const left = (i === 1) ? `[v0]` : `[vxf${i - 1}]`;
        const laa = (i === 1) ? `[a0]` : `[axf${i - 1}]`;
        const offset = Math.max(0, cumulative - TRANSITION);

        filter += `${left}[v${i}]xfade=transition=fade:duration=${TRANSITION}:offset=${offset}[vxf${i}];`;
        filter += `${laa}[a${i}]acrossfade=d=${TRANSITION}[axf${i}];`;

        const curEff = (i === durList.length - 1)
          ? Math.max(0.3, durList[i].dur - TRIM_EDGE)
          : Math.max(0.3, durList[i].dur - (2 * TRIM_EDGE));
        cumulative = cumulative + curEff - TRANSITION;
      }
      filter += `[vxf${durList.length - 1}]format=yuv420p[vout];[axf${durList.length - 1}]anull[aout]`;
    }

    const filterScript = path.join(tmpDir, 'filter.txt');
    fs.writeFileSync(filterScript, filter, 'utf-8');

    const xfadeCmd = `ffmpeg -y ${inputArgs} -/filter_complex "${filterScript}" -map "[vout]" -map "[aout]" -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart "${rawVideo}"`;
    await execPromise(xfadeCmd);

    const wInt = parseInt(targetW, 10) || 720;
    const hInt = parseInt(targetH, 10) || 1280;
    const logoW = Math.round(wInt * 0.25); // ~180px cho 720p, ~270px cho 1080p
    const marginX = Math.round(wInt * 0.035); // ~25px cho 720p
    const marginY = Math.round(hInt * 0.028); // ~35px cho 1280p

    let finalCmd = '';
    if (logoPath && fs.existsSync(logoPath)) {
      finalCmd = `ffmpeg -y -i "${rawVideo}" -i "${logoPath}" -filter_complex "[1:v]scale=${logoW}:-1[logo];[0:v]setpts=PTS/${SPEED}[v0];[v0][logo]overlay=W-w-${marginX}:H-h-${marginY}[v];[0:a]atempo=${SPEED}[a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart "${outputFinal}"`;
    } else {
      finalCmd = `ffmpeg -y -i "${rawVideo}" -filter_complex "[0:v]setpts=PTS/${SPEED}[v];[0:a]atempo=${SPEED}[a]" -map "[v]" -map "[a]" -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k -pix_fmt yuv420p -movflags +faststart "${outputFinal}"`;
    }

    await execPromise(finalCmd);

    // Kiểm tra tính toàn vẹn của file đầu ra
    if (!fs.existsSync(outputFinal) || fs.statSync(outputFinal).size < 10000) {
      throw new Error(`File video đầu ra bị lỗi hoặc rỗng sau khi xử lý FFmpeg (size: ${fs.existsSync(outputFinal) ? fs.statSync(outputFinal).size : 0})`);
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

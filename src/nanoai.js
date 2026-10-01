import axios from 'axios';

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

export async function getGoogleLabsSession(cookie) {
  const res = await axios.get('https://labs.google/fx/api/auth/session', {
    headers: { cookie }
  });
  if (!res.data?.access_token) {
    throw new Error('Google Cookie hết hạn hoặc không lấy được session access_token.');
  }
  return res.data.access_token;
}

export async function createGoogleLabsProject(cookie) {
  const res = await axios.post('https://labs.google/fx/api/trpc/project.createProject', {
    json: {
      projectTitle: new Date().toISOString(),
      toolName: 'PINHOLE'
    }
  }, { headers: { cookie } });
  return res.data?.result?.data?.json?.result?.projectId;
}

export async function uploadImageToSandbox(accessToken, projectId, base64Data, fileName) {
  const res = await axios.post('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
    clientContext: { projectId, tool: 'PINHOLE' },
    imageBytes: base64Data,
    isUserUploaded: true,
    isHidden: false,
    mimeType: 'image/jpeg',
    fileName
  }, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  return res.data?.media?.name || res.data?.name;
}

export async function generateImage(nanoaiKey, accessToken, projectId, prompt, spId, maId, bgId) {
  const payload = {
    flow_url: `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
    flow_auth_token: accessToken,
    body_json: {
      clientContext: { recaptchaToken: '', sessionId: `;${Date.now()}` },
      requests: [{
        clientContext: { recaptchaToken: '', sessionId: `;${Date.now()}`, projectId, tool: 'PINHOLE' },
        seed: '393211',
        imageModelName: 'GEM_PIX_2',
        imageAspectRatio: 'IMAGE_ASPECT_RATIO_PORTRAIT',
        prompt,
        imageInputs: [
          { name: spId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' },
          { name: maId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' },
          { name: bgId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' }
        ]
      }]
    },
    is_proxy: false
  };

  const createRes = await axios.post('https://flow-api.nanoai.pics/api/fix/create-flow', payload, {
    headers: { Authorization: `Bearer ${nanoaiKey}` }
  });

  const taskId = createRes.data?.taskId;
  if (!taskId) throw new Error('Không lấy được taskId từ create-flow ảnh');

  for (let i = 0; i < 20; i++) {
    await sleep(15000);
    const poll = await axios.get(`https://flow-api.nanoai.pics/api/fix/task-status?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${nanoaiKey}` }
    });
    const media = poll.data?.result?.media?.[0]?.image?.generatedImage;
    if (media?.fileUrl || media?.fifeUrl || media?.url) {
      return {
        url: media.fileUrl || media.fifeUrl || media.url,
        mediaName: poll.data?.result?.media?.[0]?.name
      };
    }
  }
  throw new Error('Quá thời gian chờ tạo ảnh');
}

export async function upscaleImage2K(nanoaiKey, accessToken, projectId, mediaName) {
  const res = await axios.post('https://flow-api.nanoai.pics/api/v2/images/upscale', {
    accessToken,
    mediaId: mediaName,
    projectId,
    targetResolution: 'RESOLUTION_4K'
  }, {
    headers: { Authorization: `Bearer ${nanoaiKey}` }
  });

  const taskId = res.data?.taskId;
  if (!taskId) return null;

  for (let i = 0; i < 20; i++) {
    await sleep(15000);
    const poll = await axios.get(`https://flow-api.nanoai.pics/api/v2/task?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${nanoaiKey}` }
    });
    if (poll.data?.success && poll.data?.result?.encodedImage) {
      return poll.data.result.encodedImage;
    }
  }
  return null;
}

export async function generateVideosVeo(nanoaiKey, accessToken, projectId, videoPrompts, startMediaId) {
  const requests = videoPrompts.map(prompt => ({
    aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
    seed: 13483,
    textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
    videoModelKey: 'veo_3_1_i2v_lite_low_priority',
    metadata: {},
    startImage: { mediaId: startMediaId }
  }));

  const payload = {
    flow_url: 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage',
    flow_auth_token: accessToken,
    body_json: {
      clientContext: {
        projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        recaptchaContext: { token: '', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
      },
      requests,
      useV2ModelConfig: true
    },
    is_proxy: false
  };

  const createRes = await axios.post('https://flow-api.nanoai.pics/api/fix/create-flow', payload, {
    headers: { Authorization: `Bearer ${nanoaiKey}` }
  });

  const taskId = createRes.data?.taskId;
  if (!taskId) throw new Error('Không tạo được task Veo video');

  let mediaList = [];
  for (let i = 0; i < 25; i++) {
    await sleep(20000);
    const poll = await axios.get(`https://flow-api.nanoai.pics/api/fix/task-status?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${nanoaiKey}` }
    });
    if (poll.data?.allDone || poll.data?.result?.media) {
      mediaList = poll.data?.result?.media || [];
      break;
    }
  }

  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const statusRes = await axios.post(
      'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus',
      { media: mediaList.map(m => ({ name: m.name, projectId: m.projectId })) },
      { headers: { authorization: `Bearer ${accessToken}` } }
    );

    const activeList = statusRes.data?.media || [];
    const allDone = activeList.every(m => 
      ['MEDIA_GENERATION_STATUS_SUCCESSFUL', 'MEDIA_GENERATION_STATUS_FAILED']
      .includes(m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus)
    );

    if (allDone) {
      return activeList
        .filter(m => m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL')
        .map(m => `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${m.name}`);
    }
  }
  throw new Error('Veo video generation timed out.');
}

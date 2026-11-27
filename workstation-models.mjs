// The bundled WebGPU loader uses hosted filenames as OPFS cache keys.
// Pin each Hugging Face revision and exact file size for resumable downloads.
const workspaceModelCheckpoints = [
  ['qwen3-06b', 'Qwen3 0.6B', 'Compact reasoning', 'qwen3', 'Q4_K_M', 396705472, 1792,
    'unsloth/Qwen3-0.6B-GGUF', '50968a4468ef4233ed78cd7c3de230dd1d61a56b', 'Qwen3-0.6B-Q4_K_M.gguf'],
  ['qwen35-08b', 'Qwen3.5 0.8B', 'Compact general assistant', 'qwen35', 'Q4_K_M', 532517120, 1536,
    'unsloth/Qwen3.5-0.8B-GGUF', '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', 'Qwen3.5-0.8B-Q4_K_M.gguf'],
  ['llama32-1b', 'Llama 3.2 1B Instruct', 'Compact general assistant', 'llama', 'Q4_K_M', 807694464, 1792,
    'bartowski/Llama-3.2-1B-Instruct-GGUF', '067b946cf014b7c697f3654f621d577a3e3afd1c', 'Llama-3.2-1B-Instruct-Q4_K_M.gguf'],
  ['gemma3-1b', 'Gemma 3 1B IT', 'Compact multilingual assistant', 'gemma3', 'Q8_0', 1069306624, 1792,
    'bartowski/google_gemma-3-1b-it-GGUF', '116f76234503685a98f572982177b11d44ec8ff1', 'google_gemma-3-1b-it-Q8_0.gguf'],
  ['qwen-coder-15b', 'Qwen2.5-Coder 1.5B Instruct', 'Compact code assistant', 'qwen2', 'Q4_K_M', 986048800, 2048,
    'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', '1af47f78b1f9b0c242fabe43f7a365d5a67f3207', 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf'],
  ['qwen3-17b', 'Qwen3 1.7B', 'Reasoning and multilingual chat', 'qwen3', 'Q4_K_M', 1107409472, 2560,
    'unsloth/Qwen3-1.7B-GGUF', 'd7f544eead698dbd1f15126ef60b45a1e1933222', 'Qwen3-1.7B-Q4_K_M.gguf'],
  ['llama32-3b', 'Llama 3.2 3B Instruct', 'General assistant', 'llama', 'Q4_K_M', 2019377696, 3584,
    'bartowski/Llama-3.2-3B-Instruct-GGUF', '5ab33fa94d1d04e903623ae72c95d1696f09f9e8', 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'],
  ['qwen-coder-3b', 'Qwen2.5-Coder 3B Instruct', 'Code assistant', 'qwen2', 'Q4_K_M', 1929903360, 3072,
    'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF', '7c137640ef0332dfedb229f2504c58d83ed4307a', 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf'],
  ['qwen3-4b', 'Qwen3 4B Instruct 2507', 'General assistant', 'qwen3', 'Q4_K_M', 2497281120, 4096,
    'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'a06e946bb6b655725eafa393f4a9745d460374c9', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'],
  ['gemma3-4b', 'Gemma 3 4B IT', 'Multilingual text', 'gemma3', 'Q4_K_M', 2489758112, 3840,
    'bartowski/google_gemma-3-4b-it-GGUF', '71506238f970075ca85125cd749c28b1b0eee84e', 'google_gemma-3-4b-it-Q4_K_M.gguf'],
  ['qwen-coder-7b', 'Qwen2.5-Coder 7B Instruct', 'Code assistant', 'qwen2', 'Q4_K_M', 4683074336, 6400,
    'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', '1f629da0c8bed16b9e50cee91c70693650e66c35', 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf'],
  ['llama31-8b', 'Llama 3.1 8B Instruct', 'General assistant', 'llama', 'Q4_K_M', 4920739232, 6656,
    'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'bf5b95e96dac0462e2a09145ec66cae9a3f12067', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'],
  ['hermes3-8b', 'Hermes 3 Llama 3.1 8B', 'Instruction following and structured output', 'llama', 'Q4_K_M', 4920734624, 6656,
    'bartowski/Hermes-3-Llama-3.1-8B-GGUF', '223c8e24dec0f863b6abe4c89bf20f6941b805e2', 'Hermes-3-Llama-3.1-8B-Q4_K_M.gguf'],
  ['qwen3-8b', 'Qwen3 8B', 'Reasoning and multilingual chat', 'qwen3', 'Q4_K_M', 5027783488, 6912,
    'Qwen/Qwen3-8B-GGUF', '7c41481f57cb95916b40956ab2f0b139b296d974', 'Qwen3-8B-Q4_K_M.gguf'],
  ['gemma3-12b', 'Gemma 3 12B IT', 'Multilingual text, high memory', 'gemma3', 'Q4_K_M', 7300575264, 9216,
    'bartowski/google_gemma-3-12b-it-GGUF', '648e3a36a77c8a9f12d86e741f9dcb9089c769c4', 'google_gemma-3-12b-it-Q4_K_M.gguf'],
  ['qwen-coder-14b', 'Qwen2.5-Coder 14B Instruct', 'Code assistant, high memory', 'qwen2', 'Q4_K_M', 8988111072, 11264,
    'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', '5b379ec4bf71bafecb5f9081ad28b19939128988', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf'],
  ['qwen3-14b', 'Qwen3 14B', 'Reasoning, high memory', 'qwen3', 'Q4_K_M', 9001752960, 11264,
    'Qwen/Qwen3-14B-GGUF', '530227a7d994db8eca5ab5ced2fb692b614357fd', 'Qwen3-14B-Q4_K_M.gguf'],
  ['qwen38-27b', 'Qwen3.8 27B', 'Experimental, high memory and paged weights', 'qwen35', 'Q4_K_M', 19403684480, 16384,
    'ggml-org/Qwen3.8-27B-GGUF', 'c1869413dece09109e55b7dcc2c77ef382b0d0bd', 'Qwen3.8-27B-Q4_K_M.gguf'],
];

const workspaceAgentModels = new Map(workspaceModelCheckpoints.map(
  ([profile, id, purpose, architecture, quant, bytes, gpuBudgetMiB, repo, revision, filename]) => [
    profile, Object.freeze({
      id, purpose, architecture, quant, bytes, gpuBudgetMiB,
      hosted: '/models/' + filename,
      remote: 'https://huggingface.co/' + repo + '/resolve/' + revision + '/' + filename,
    }),
  ],
));

function adaptWorkspaceModelRegistry(source) {
  source = replaceRequired(source,
    'if(c.config.architecture!==`qwen35`)throw Error(`Expected qwen35 GGUF architecture; got ${c.config.architecture}`);',
    'if(c.config.architecture!==(this.model.architecture??`qwen35`))throw Error(`Expected ${this.model.architecture??`qwen35`} GGUF architecture; got ${c.config.architecture}`);',
  );
  source = replaceRequired(source,
    '`Inference backend: FP32 WebGPU WGSL (Q4_K GGUF, no shader-f16 required)`',
    '`Inference backend: FP32 WebGPU WGSL (${this.model.quant} GGUF, no shader-f16 required)`',
  );
  // SwiftShader's WGSL tanh returns NaN for large arguments. The GELU
  // approximation has already saturated at the clamp boundaries in FP32.
  source = replaceRequired(source,
    'tanh(0.7978845608*(x+0.044715*x*x*x))',
    'tanh(clamp(0.7978845608*(x+0.044715*x*x*x), -10.0, 10.0))',
  );
  source = replaceRequired(source,
    'cT=[`auto`,`strands`,`botpsy`,`qwen2b`,`docling`,`qwen4b`,`qwen9b`],lT=new Map([[`botpsy`,jx],[`qwen2b`,Mx],[`qwen4b`,Nx],[`qwen9b`,Px]])',
    'cT=[`auto`,`strands`,`botpsy`,`qwen2b`,`docling`,`qwen4b`,`qwen9b`,...workstation.models.keys()],lT=new Map([[`botpsy`,jx],[`qwen2b`,Mx],[`qwen4b`,Nx],[`qwen9b`,Px],...workstation.models])',
  );
  const start = source.indexOf('async list(){let e=async e=>{let t=await bb(e),');
  const end = source.indexOf('gpuMemory(){', start);
  if (start < 0 || end <= start) throw Error('The bundled model list changed');
  return source.slice(0, start) + 'async list(){return workstation.formatModels(this,cT,lT,bb)}' + source.slice(end);
}

async function formatWorkspaceAgentModels(runner, profiles, models, readCache) {
  const mib = bytes => (bytes / MiB).toFixed(1) + ' MiB';
  const descriptions = await Promise.all(profiles.map(async profile => {
    if (profile === 'auto') return 'Strands with BotPsy for open-ended tasks';
    if (profile === 'strands') {
      return 'Strands v21 decision model · ' + await runner.strands.cacheStatus().catch(error => error.message);
    }
    if (profile === 'docling') {
      return 'IBM Granite Docling 258M for PDFs and page images · ' + runner.agent.documentModel.status();
    }
    const model = models.get(profile);
    const cache = await readCache(model);
    const size = mib(model.bytes);
    let download = size + ' download';
    if (cache.present) {
      if (cache.sizeMatches && cache.ggufMagic) download = size + ' cached';
      else if (cache.ggufMagic) download = mib(cache.bytes) + ' / ' + size + ' cached';
      else download = size + ' download (invalid cache)';
    }
    return [model.id + ' ' + model.quant, model.purpose, download].filter(Boolean).join(' · ');
  }));
  return profiles.map((profile, index) =>
    (index + 1) + '. ' + profile + (profile === runner.selected ? ' [selected]' : '') + ' — ' + descriptions[index],
  ).join('\n') + '\n\n' + runner.help();
}

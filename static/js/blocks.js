/* The block registry (CLAUDE.md §5).
   Adding a type = one entry here + one branch in the editor + one in the renderer.
   Nothing else in the app special-cases a block type. */

window.BLOCK_TYPES = [
  { type: 'title',     label: 'Title',           interactive: false, make: () => ({ text: '' }) },
  { type: 'text',      label: 'Text',            interactive: false, make: () => ({ text: '' }) },
  { type: 'image',     label: 'Image',           interactive: false, make: () => ({ key: '', caption: '' }) },
  { type: 'video',     label: 'Video',           interactive: false, make: () => ({ url: '', key: '', label: '' }) },
  { type: 'audio',     label: 'Audio',           interactive: false, make: () => ({ key: '', caption: '' }) },
  { type: 'embed',     label: 'Embed (Slides)',  interactive: false, make: () => ({ url: '', label: '' }) },
  { type: 'link',      label: 'Link',            interactive: false, make: () => ({ url: '', label: '' }) },
  { type: 'prompt',    label: 'Prompt',          interactive: false, make: () => ({ text: '' }) },
  { type: 'quiz_mc',   label: 'Multiple choice', interactive: true,  make: () => ({
      question: '',
      options: [{ id: newId('o'), text: '' }, { id: newId('o'), text: '' }],
      correctId: null, feedbackCorrect: '', feedbackWrong: '' }) },
  { type: 'quiz_open', label: 'Open answer',     interactive: true,  make: () => ({ question: '' }) },
  { type: 'upload',    label: 'Upload (audio/photo)', interactive: true, make: () => ({
      prompt: '', accept: ['audio', 'image'] }) },
];

window.blockMeta = (type) => window.BLOCK_TYPES.find((b) => b.type === type) || { label: type, interactive: false };

window.makeBlock = function (type) {
  const meta = window.BLOCK_TYPES.find((b) => b.type === type);
  return Object.assign({ id: newId('b'), type }, meta.make());
};

/* YouTube / Vimeo watch links become embeddable player URLs; anything else is used as-is. */
window.embedUrl = function (url) {
  if (!url) return '';
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/);
  if (yt) return 'https://www.youtube.com/embed/' + yt[1];
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return 'https://player.vimeo.com/video/' + vimeo[1];
  return url;
};

/* ------------------------------------------------------------------ renderer */

window.BlockView = {
  props: ['block', 'answer'],
  emits: ['answer'],
  data() {
    return {
      picked: this.answer ? this.answer.option_id : null,
      draft: this.answer ? (this.answer.value_text || '') : '',
      savedAt: 0,
    };
  },
  computed: {
    correct() { return this.picked && this.picked === this.block.correctId; },
    dirty() { return this.draft.trim() !== ((this.answer && this.answer.value_text) || ''); },
  },
  methods: {
    embedUrl(url) { return window.embedUrl(url); },
    pick(optionId) {
      this.picked = optionId;
      this.$emit('answer', { block_id: this.block.id, kind: 'quiz_mc', option_id: optionId });
    },
    saveOpen() {
      if (!this.draft.trim()) return;
      this.$emit('answer', { block_id: this.block.id, kind: 'quiz_open', value_text: this.draft.trim() });
      this.savedAt = Date.now();
    },
    optionClass(option) {
      if (this.picked !== option.id) return '';
      return this.correct ? 'picked right' : 'picked wrong';
    },
  },
  template: `
    <div class="block">
      <div v-if="block.type === 'title'" class="block-title">{{ block.text }}</div>

      <p v-else-if="block.type === 'text'" style="white-space:pre-wrap">{{ block.text }}</p>

      <figure v-else-if="block.type === 'image'" style="margin:0">
        <img v-if="block.url" :src="block.url" :alt="block.caption || ''">
        <div v-else class="empty card">Image not uploaded yet.</div>
        <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
      </figure>

      <div v-else-if="block.type === 'video'">
        <label v-if="block.label">{{ block.label }}</label>
        <video v-if="block.key" class="video" controls preload="metadata"
               :src="block.url"></video>
        <iframe v-else-if="block.url" :src="embedUrl(block.url)" allowfullscreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"></iframe>
      </div>

      <div v-else-if="block.type === 'embed'">
        <label v-if="block.label">{{ block.label }}</label>
        <iframe :src="embedUrl(block.url)" allowfullscreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"></iframe>
      </div>

      <div v-else-if="block.type === 'audio'">
        <audio v-if="block.url" controls preload="metadata" :src="block.url"
               style="width:100%"></audio>
        <div v-else class="empty card">Audio not uploaded yet.</div>
        <figcaption v-if="block.caption" class="muted small">{{ block.caption }}</figcaption>
      </div>

      <p v-else-if="block.type === 'link'">
        <a :href="block.url" target="_blank" rel="noopener">{{ block.label || block.url }} &rarr;</a>
      </p>

      <div v-else-if="block.type === 'prompt'" class="prompt-block">
        <b>Try this:</b> {{ block.text }}
      </div>

      <div v-else-if="block.type === 'quiz_mc'" class="quiz">
        <div class="q">{{ block.question }}</div>
        <div v-for="option in block.options" :key="option.id"
             class="option" :class="optionClass(option)" @click="pick(option.id)">
          <input type="radio" :checked="picked === option.id" @click.stop="pick(option.id)">
          <span>{{ option.text }}</span>
        </div>
        <div v-if="picked" class="feedback" :class="correct ? 'right' : 'wrong'">
          {{ correct
              ? (block.feedbackCorrect || 'Correct!')
              : (block.feedbackWrong || 'Not quite — have another go.') }}
        </div>
      </div>

      <div v-else-if="block.type === 'quiz_open'" class="quiz">
        <div class="q">{{ block.question }}</div>
        <textarea v-model="draft" placeholder="Write your answer here..."></textarea>
        <div class="row" style="margin-top:.6rem">
          <button class="btn sm shrink" :disabled="!draft.trim() || !dirty" @click="saveOpen">
            {{ dirty ? 'Save answer' : 'Saved' }}
          </button>
          <span v-if="savedAt" class="saved shrink">&check; Saved</span>
        </div>
      </div>

      <div v-else-if="block.type === 'upload'" class="quiz">
        <div class="q">{{ block.prompt }}</div>
        <p class="muted small" style="margin:0">
          Uploads are coming soon — for now, bring this to your next lesson.
        </p>
      </div>
    </div>`,
};

/* ------------------------------------------------------------------ editor */

window.BlockEditor = {
  props: ['block', 'index', 'total', 'lessonId'],
  emits: ['move', 'remove'],
  data() { return { uploading: false, uploadError: '' }; },
  computed: {
    meta() { return blockMeta(this.block.type); },
  },
  methods: {
    addOption() {
      this.block.options.push({ id: newId('o'), text: '' });
    },
    removeOption(option) {
      /* Deleting an option never renumbers the others — old answers stay resolvable. */
      this.block.options = this.block.options.filter((o) => o.id !== option.id);
      if (this.block.correctId === option.id) this.block.correctId = null;
    },
    async uploadMedia(event, kind) {
      const file = event.target.files[0];
      if (!file) return;
      this.uploading = true;
      this.uploadError = '';
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('lesson_id', this.lessonId);
        form.append('block_id', this.block.id);
        form.append('kind', kind);
        const res = await API.upload('/uploads', form);
        this.block.key = res.key;
        this.block.url = res.url;   // signed URL; save() drops it since key is set
      } catch (err) {
        this.uploadError = err.message;
      } finally {
        this.uploading = false;
        event.target.value = '';
      }
    },
    clearFile() {
      /* Back to an empty block — for video this returns it to link (embed) mode. */
      this.block.key = '';
      this.block.url = '';
    },
  },
  template: `
    <div class="edit-block" :class="{ interactive: meta.interactive }">
      <div class="edit-head">
        <span class="pill" :class="meta.interactive ? 'red' : ''">{{ meta.label }}</span>
        <span class="grow"></span>
        <button class="icon-btn" title="Move up" :disabled="index === 0" @click="$emit('move', -1)">&uarr;</button>
        <button class="icon-btn" title="Move down" :disabled="index === total - 1" @click="$emit('move', 1)">&darr;</button>
        <button class="icon-btn" title="Delete" @click="$emit('remove')">&times;</button>
      </div>

      <input v-if="block.type === 'title'" type="text" v-model="block.text" placeholder="Lesson title">

      <textarea v-else-if="block.type === 'text'" v-model="block.text"
                placeholder="Write the lesson text..."></textarea>

      <div v-else-if="block.type === 'prompt'">
        <textarea v-model="block.text" placeholder="A thing for the student to try or think about..."></textarea>
      </div>

      <div v-else-if="block.type === 'image'">
        <img v-if="block.url" :src="block.url" style="max-width:220px;border-radius:8px;display:block;margin-bottom:.6rem">
        <div class="field">
          <label>Image file</label>
          <input type="file" accept="image/*" @change="uploadMedia($event, 'image')" :disabled="uploading">
          <p v-if="uploading" class="small muted" style="margin:.3rem 0 0">Uploading&hellip;</p>
          <p v-if="uploadError" class="small" style="color:var(--red);margin:.3rem 0 0">{{ uploadError }}</p>
        </div>
        <div class="field" style="margin:0">
          <label>Caption</label>
          <input type="text" v-model="block.caption" placeholder="A red apple">
        </div>
      </div>

      <div v-else-if="block.type === 'video'">
        <!-- File mode: a video has been uploaded. -->
        <div v-if="block.key" class="field">
          <video v-if="block.url" controls preload="metadata"
                 style="max-width:320px;border-radius:8px;display:block;margin-bottom:.5rem" :src="block.url"></video>
          <button class="btn ghost sm" @click="clearFile">Remove file (use a link instead)</button>
        </div>
        <!-- Link mode: paste a YouTube/Vimeo link, or upload a file. -->
        <template v-else>
          <div class="field">
            <label>Video link</label>
            <input type="text" v-model="block.url" placeholder="https://www.youtube.com/watch?v=...">
            <p class="small muted" style="margin:.3rem 0 0">YouTube and Vimeo links play inline.</p>
          </div>
          <div class="field">
            <label>…or upload a video file <span class="muted small">(mp4/webm, up to 200MB)</span></label>
            <input type="file" accept="video/*" @change="uploadMedia($event, 'video')" :disabled="uploading">
            <p v-if="uploading" class="small muted" style="margin:.3rem 0 0">Uploading&hellip; (large files take a moment)</p>
            <p v-if="uploadError" class="small" style="color:var(--red);margin:.3rem 0 0">{{ uploadError }}</p>
          </div>
        </template>
        <div class="field" style="margin:0">
          <label>Label</label>
          <input type="text" v-model="block.label" placeholder="The Colours Song">
        </div>
      </div>

      <div v-else-if="block.type === 'audio'">
        <div class="field">
          <audio v-if="block.url" controls preload="metadata" style="width:100%;margin-bottom:.5rem" :src="block.url"></audio>
          <label>Audio file <span class="muted small">(mp3/m4a/wav, up to 30MB)</span></label>
          <input type="file" accept="audio/*" @change="uploadMedia($event, 'audio')" :disabled="uploading">
          <p v-if="uploading" class="small muted" style="margin:.3rem 0 0">Uploading&hellip;</p>
          <p v-if="uploadError" class="small" style="color:var(--red);margin:.3rem 0 0">{{ uploadError }}</p>
        </div>
        <div class="field" style="margin:0">
          <label>Caption</label>
          <input type="text" v-model="block.caption" placeholder="Listen and repeat">
        </div>
      </div>

      <div v-else-if="block.type === 'embed' || block.type === 'link'">
        <div class="field">
          <label>{{ block.type === 'link' ? 'Link URL' : 'URL' }}</label>
          <input type="text" v-model="block.url" placeholder="https://...">
        </div>
        <div class="field" style="margin:0">
          <label>Label</label>
          <input type="text" v-model="block.label" placeholder="Slides">
        </div>
      </div>

      <div v-else-if="block.type === 'quiz_mc'">
        <div class="field">
          <label>Question</label>
          <input type="text" v-model="block.question" placeholder="What colour is the sky?">
        </div>
        <label>Options <span class="muted small">(tick the correct one)</span></label>
        <div v-for="(option, i) in block.options" :key="option.id" class="opt-row">
          <input type="radio" :name="'correct_' + block.id" :value="option.id" v-model="block.correctId">
          <input type="text" v-model="option.text" :placeholder="'Option ' + (i + 1)">
          <button class="icon-btn" :disabled="block.options.length <= 2"
                  @click="removeOption(option)">&times;</button>
        </div>
        <button class="btn ghost sm" style="margin:.2rem 0 .9rem" @click="addOption">+ Add option</button>
        <div class="row">
          <div class="field">
            <label>If correct, say</label>
            <input type="text" v-model="block.feedbackCorrect" placeholder="Yes! The sky is blue.">
          </div>
          <div class="field">
            <label>If wrong, say</label>
            <input type="text" v-model="block.feedbackWrong" placeholder="Look outside — try again!">
          </div>
        </div>
      </div>

      <div v-else-if="block.type === 'quiz_open'">
        <label>Question</label>
        <input type="text" v-model="block.question" placeholder="Write three things that are red.">
      </div>

      <div v-else-if="block.type === 'upload'">
        <label>Prompt</label>
        <input type="text" v-model="block.prompt" placeholder="Record yourself saying the colours.">
        <p class="small muted" style="margin:.5rem 0 0">
          Students will be able to upload audio or a photo here (coming soon).
        </p>
      </div>
    </div>`,
};

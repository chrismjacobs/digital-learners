/* Mama Lucy's English Explorers — the whole client.
   Hash routing, no build step. Server owns access control; this is presentation. */

const { createApp, reactive, computed } = Vue;

/* ------------------------------------------------------------------ router */

const route = reactive({ name: 'home', id: null, query: {} });

function parseHash() {
  const raw = (location.hash || '#/').slice(1);
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  route.name = parts[0] || 'home';
  route.id = parts[1] || null;
  route.query = Object.fromEntries(new URLSearchParams(qs || ''));
}
window.addEventListener('hashchange', parseHash);
parseHash();

const go = (path) => { location.hash = path; };

/* ------------------------------------------------------------------ views */

const AuthView = {
  props: ['onSignedIn'],
  data() {
    return {
      tab: 'login', busy: false, error: '',
      form: { code: '', name: '', email: '', password: '' },
    };
  },
  methods: {
    async submit() {
      this.busy = true;
      this.error = '';
      try {
        const path = this.tab === 'login' ? '/login' : '/register';
        const res = await API.post(path, this.form);
        this.onSignedIn(res.user);
      } catch (err) {
        this.error = err.message;
      } finally {
        this.busy = false;
      }
    },
  },
  template: `
    <div class="auth">
      <div>
        <div class="auth-logo">
          <img src="/static/img/logo.png" alt="">
          <h1>Mama Lucy's English Explorers</h1>
          <p>Sign in to keep exploring.</p>
        </div>
        <div class="card">
          <div class="stripes"><i></i><i></i><i></i></div>
          <div class="tabs">
            <button :class="{ on: tab === 'login' }" @click="tab = 'login'; error = ''">Sign in</button>
            <button :class="{ on: tab === 'register' }" @click="tab = 'register'; error = ''">Register</button>
          </div>
          <form class="pad" @submit.prevent="submit">
            <div v-if="error" class="alert bad">{{ error }}</div>

            <div v-if="tab === 'register'" class="field">
              <label>Registration code</label>
              <input type="text" v-model="form.code" placeholder="From your teacher" required>
            </div>
            <div v-if="tab === 'register'" class="field">
              <label>Your name</label>
              <input type="text" v-model="form.name" required>
            </div>
            <div class="field">
              <label>Email</label>
              <input type="email" v-model="form.email" required>
            </div>
            <div class="field">
              <label>Password</label>
              <input type="password" v-model="form.password" required>
            </div>
            <button class="btn" style="width:100%" :disabled="busy">
              {{ busy ? 'Please wait…' : (tab === 'login' ? 'Sign in' : 'Create my account') }}
            </button>
          </form>
        </div>
        <p style="text-align:center;margin-top:1rem">
          <a class="small muted" href="#/">← Back to courses</a>
        </p>
      </div>
    </div>`,
};

const HomeView = {
  props: ['user'],
  data() { return { courses: [], categories: [], loading: true, error: '' }; },
  computed: {
    sections() {
      return this.categories
        .map((cat) => ({
          ...cat,
          courses: this.courses.filter((c) => c.category_id === cat.id),
        }))
        .filter((s) => s.courses.length); /* empty categories render no section */
    },
    uncategorised() { return this.courses.filter((c) => !c.category_id); },
  },
  async created() {
    try {
      const [courses, cats] = await Promise.all([
        API.get('/my/courses'), API.get('/categories'),
      ]);
      this.courses = courses.courses;
      this.categories = cats.categories;
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Welcome back, {{ user.name }}</h1>
          <p class="sub">{{ user.role === 'teacher'
            ? 'Every course you have built.' : 'Your courses. Pick up where you left off.' }}</p>
        </div>
        <a v-if="user.role === 'teacher'" class="btn" href="#/courses">+ Add course</a>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>
      <p v-if="loading" class="empty">Loading…</p>
      <div v-else-if="!courses.length" class="card empty">
        {{ user.role === 'teacher'
          ? 'No courses yet. Create your first one from All courses.'
          : 'You have no courses yet. Your teacher will assign one soon.' }}
      </div>

      <div v-for="section in sections" :key="section.id">
        <div class="section-head">
          <h2>{{ section.name }}</h2>
          <a :href="'#/courses?category=' + section.id">See all &rarr;</a>
        </div>
        <div class="grid">
          <course-card v-for="c in section.courses.slice(0, 4)" :key="c.id" :course="c"></course-card>
        </div>
      </div>

      <div v-if="uncategorised.length">
        <div class="section-head"><h2>Uncategorised</h2></div>
        <div class="grid">
          <course-card v-for="c in uncategorised" :key="c.id" :course="c"></course-card>
        </div>
      </div>
    </div>`,
};

const CourseCard = {
  props: ['course'],
  computed: {
    percent() {
      const p = this.course.progress;
      if (!p || !p.total) return 0;
      return Math.round((p.done / p.total) * 100);
    },
  },
  template: `
    <a class="course-card" :href="'#/course/' + course.id">
      <div class="thumb">
        <img v-if="course.title_card_url" :src="course.title_card_url" :alt="course.title">
        <span v-else>🌍</span>
      </div>
      <div class="body">
        <h3>{{ course.title }}</h3>
        <span v-if="!course.published" class="pill">Draft</span>
        <div v-if="course.progress && course.progress.total" style="margin-top:auto">
          <div class="bar"><i :style="{ width: percent + '%' }"></i></div>
          <div class="small muted" style="margin-top:.3rem">
            {{ course.progress.done }} / {{ course.progress.total }} lessons
          </div>
        </div>
      </div>
    </a>`,
};

const CoursesView = {
  props: ['user'],
  data() {
    return {
      courses: [], categories: [], loading: true,
      filter: route.query.category || '',
      showNew: false, error: '',
      draft: { title: '', category_id: '', overview: '' },
    };
  },
  computed: {
    shown() {
      return this.filter ? this.courses.filter((c) => c.category_id === this.filter) : this.courses;
    },
  },
  methods: {
    categoryName(id) {
      const cat = this.categories.find((c) => c.id === id);
      return cat ? cat.name : '—';
    },
    async load() {
      try {
        const [courses, cats] = await Promise.all([
          API.get('/my/courses'), API.get('/categories'),
        ]);
        this.courses = courses.courses;
        this.categories = cats.categories;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },
    async create() {
      this.error = '';
      try {
        const res = await API.post('/courses', this.draft);
        this.showNew = false;
        this.draft = { title: '', category_id: '', overview: '' };
        go('/course/' + res.id);
      } catch (err) {
        this.error = err.message;
      }
    },
  },
  created() { this.load(); },
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>All courses</h1>
          <p class="sub">{{ shown.length }} course{{ shown.length === 1 ? '' : 's' }}</p>
        </div>
        <select v-model="filter" class="shrink" style="max-width:200px">
          <option value="">All categories</option>
          <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button v-if="user.role === 'teacher'" class="btn shrink" @click="showNew = true">+ Add course</button>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>

      <div class="card">
        <table v-if="shown.length">
          <thead><tr>
            <th>Course</th><th>Category</th><th>Progress</th>
            <th v-if="user.role === 'teacher'">Status</th><th></th>
          </tr></thead>
          <tbody>
            <tr v-for="c in shown" :key="c.id">
              <td><b>{{ c.title }}</b></td>
              <td class="muted">{{ categoryName(c.category_id) }}</td>
              <td class="muted">
                <span v-if="c.progress && c.progress.total">
                  {{ c.progress.done }} / {{ c.progress.total }}
                </span>
                <span v-else>No lessons</span>
              </td>
              <td v-if="user.role === 'teacher'">
                <span class="pill" :class="c.published ? 'ok' : ''">
                  {{ c.published ? 'Published' : 'Draft' }}
                </span>
                <span v-if="c.promoted" class="pill navy" style="margin-left:.3rem">Promoted</span>
              </td>
              <td style="text-align:right">
                <a class="btn ghost sm" :href="'#/course/' + c.id">Open</a>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="loading" class="empty">Loading…</p>
        <p v-else class="empty">Nothing here yet.</p>
      </div>

      <div v-if="showNew" class="modal-backdrop" @click.self="showNew = false">
        <div class="modal">
          <div class="modal-head">
            <h2>New course</h2>
            <button class="icon-btn" @click="showNew = false">&times;</button>
          </div>
          <form class="pad" @submit.prevent="create">
            <div v-if="error" class="alert bad">{{ error }}</div>
            <div class="field">
              <label>Title</label>
              <input type="text" v-model="draft.title" required>
            </div>
            <div class="field">
              <label>Category</label>
              <select v-model="draft.category_id">
                <option value="">— none —</option>
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Overview (the course goals)</label>
              <textarea v-model="draft.overview"></textarea>
            </div>
            <button class="btn">Create course</button>
          </form>
        </div>
      </div>
    </div>`,
};

const CourseView = {
  props: ['user'],
  data() {
    return {
      course: null, lessons: [], testimonials: [], images: [], categories: [],
      loading: true, error: '', editing: false, saving: false, uploadingPhoto: false,
      draft: {}, newLesson: { title: '', code: '', kind: 'Main' },
      newTestimonial: { author_name: '', body: '' },
    };
  },
  computed: {
    teacher() { return this.user.role === 'teacher'; },
    percent() {
      const p = this.course.progress;
      return p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    },
  },
  methods: {
    /* Goals are edited as a list of rows — same add/remove/reorder shape as the
       multiple-choice options in BlockEditor. */
    addGoal() { this.draft.goals.push(''); },
    removeGoal(i) { this.draft.goals.splice(i, 1); },
    moveGoal(i, delta) {
      const target = i + delta;
      if (target < 0 || target >= this.draft.goals.length) return;
      const [goal] = this.draft.goals.splice(i, 1);
      this.draft.goals.splice(target, 0, goal);
    },
    async load() {
      try {
        const res = await API.get('/courses/' + route.id);
        this.course = res.course;
        this.lessons = res.lessons;
        this.testimonials = res.testimonials;
        this.images = res.images || [];
        this.draft = {
          title: res.course.title, category_id: res.course.category_id || '',
          overview: res.course.overview || '', published: res.course.published,
          promoted: res.course.promoted,
          goals: (res.course.goals || []).slice(),
        };
        if (this.teacher) this.categories = (await API.get('/categories')).categories;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },
    async save() {
      this.saving = true;
      try {
        await API.patch('/courses/' + this.course.id, this.draft);
        this.editing = false;
        await this.load();
      } catch (err) {
        this.error = err.message;
      } finally {
        this.saving = false;
      }
    },
    async uploadTitleCard(event) {
      const file = event.target.files[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await API.upload('/courses/' + this.course.id + '/title-card', form);
        this.course.title_card_url = res.url;
      } catch (err) {
        this.error = err.message;
      }
      event.target.value = '';
    },
    async addLesson() {
      const res = await API.post('/courses/' + this.course.id + '/lessons', this.newLesson);
      this.newLesson = { title: '', code: '', kind: 'Main' };
      go('/builder/' + res.id);
    },
    async addTestimonial() {
      await API.post('/courses/' + this.course.id + '/testimonials', this.newTestimonial);
      this.newTestimonial = { author_name: '', body: '' };
      await this.load();
    },
    async removeTestimonial(id) {
      await API.del('/testimonials/' + id);
      await this.load();
    },
    async uploadPhoto(event) {
      const file = event.target.files[0];
      if (!file) return;
      this.uploadingPhoto = true;
      this.error = '';
      try {
        const form = new FormData();
        form.append('file', file);
        await API.upload('/courses/' + this.course.id + '/images', form);
        await this.load();
      } catch (err) {
        this.error = err.message;
      } finally {
        this.uploadingPhoto = false;
        event.target.value = '';
      }
    },
    async savePhotoCaption(img) {
      try {
        await API.patch('/courses/' + this.course.id + '/images/' + img.id,
                        { caption: img.caption });
      } catch (err) {
        this.error = err.message;
      }
    },
    async movePhoto(i, delta) {
      const target = i + delta;
      if (target < 0 || target >= this.images.length) return;
      /* Swap the two rows' sort_order so the new order sticks. */
      const a = this.images[i], b = this.images[target];
      try {
        await API.patch('/courses/' + this.course.id + '/images/' + a.id, { sort_order: b.sort_order });
        await API.patch('/courses/' + this.course.id + '/images/' + b.id, { sort_order: a.sort_order });
        await this.load();
      } catch (err) {
        this.error = err.message;
      }
    },
    async deletePhoto(id) {
      if (!confirm('Remove this photo?')) return;
      try {
        await API.del('/courses/' + this.course.id + '/images/' + id);
        await this.load();
      } catch (err) {
        this.error = err.message;
      }
    },
    async removeLesson(lesson) {
      if (!confirm('Delete "' + lesson.title + '" and all its answers?')) return;
      await API.del('/lessons/' + lesson.id);
      await this.load();
    },
    async deleteCourse() {
      if (!confirm('Delete this whole course, its lessons and all answers?')) return;
      await API.del('/courses/' + this.course.id);
      go('/courses');
    },
    openLesson(lesson) {
      if (this.teacher) go('/builder/' + lesson.id);
      else if (lesson.unlocked) go('/lesson/' + lesson.id);
    },
  },
  created() { this.load(); },
  template: `
    <div class="page">
      <div v-if="error" class="alert bad">{{ error }}</div>
      <p v-if="loading" class="empty">Loading…</p>

      <div v-else-if="course">
        <div class="hero">
          <div>
            <div class="thumb">
              <img v-if="course.title_card_url" :src="course.title_card_url" :alt="course.title">
              <span v-else>🌍</span>
            </div>
            <label v-if="teacher" class="btn ghost sm" style="margin-top:.6rem;width:100%">
              Change title card
              <input type="file" accept="image/*" hidden @change="uploadTitleCard">
            </label>
          </div>

          <div>
            <div class="page-head" style="margin-bottom:.6rem">
              <div>
                <h1>{{ course.title }}</h1>
                <p class="sub" v-if="course.progress && course.progress.total">
                  {{ course.progress.done }} of {{ course.progress.total }} lessons complete
                </p>
              </div>
              <span v-if="teacher && !course.published" class="pill shrink">Draft</span>
              <span v-if="teacher && course.promoted" class="pill navy shrink">Promoted</span>
            </div>

            <div v-if="course.progress && course.progress.total" class="bar" style="margin-bottom:1rem">
              <i :style="{ width: percent + '%' }"></i>
            </div>

            <p style="white-space:pre-wrap">{{ course.overview || 'No overview yet.' }}</p>

            <div v-if="course.goals && course.goals.length">
              <h2 style="margin-top:1.25rem;font-size:1.05rem">What you'll be able to do</h2>
              <ul class="goals">
                <li v-for="(goal, i) in course.goals" :key="i">{{ goal }}</li>
              </ul>
            </div>

            <div v-if="teacher" class="row" style="margin-top:1rem">
              <button class="btn ghost sm shrink" @click="editing = !editing">Edit details</button>
              <button class="btn ghost sm shrink" @click="deleteCourse">Delete course</button>
            </div>
          </div>
        </div>

        <div v-if="editing" class="card pad" style="margin-bottom:1.5rem">
          <div class="row">
            <div class="field">
              <label>Title</label>
              <input type="text" v-model="draft.title">
            </div>
            <div class="field">
              <label>Category</label>
              <select v-model="draft.category_id">
                <option value="">— none —</option>
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Overview</label>
            <textarea v-model="draft.overview"></textarea>
          </div>

          <div class="field">
            <label>Goals <span class="muted small">(what the student will be able to do)</span></label>
            <div v-for="(goal, i) in draft.goals" :key="i" class="goal-row">
              <input type="text" v-model="draft.goals[i]" placeholder="Name ten colours out loud">
              <button class="icon-btn" title="Move up" :disabled="i === 0"
                      @click="moveGoal(i, -1)">&uarr;</button>
              <button class="icon-btn" title="Move down" :disabled="i === draft.goals.length - 1"
                      @click="moveGoal(i, 1)">&darr;</button>
              <button class="icon-btn" title="Remove" @click="removeGoal(i)">&times;</button>
            </div>
            <button class="btn ghost sm" @click="addGoal">+ Add goal</button>
          </div>

          <div style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem">
            <label style="display:flex;gap:.4rem;align-items:center;font-weight:600">
              <input type="checkbox" v-model="draft.published" style="width:auto">
              Published <span class="muted small" style="font-weight:400">— enrolled students can open it</span>
            </label>
            <label style="display:flex;gap:.4rem;align-items:center;font-weight:600">
              <input type="checkbox" v-model="draft.promoted" style="width:auto">
              Promote <span class="muted small" style="font-weight:400">— show its info to website visitors (no login)</span>
            </label>
          </div>
          <div class="row">
            <span style="flex:1"></span>
            <button class="btn shrink" :disabled="saving" @click="save">
              {{ saving ? 'Saving…' : 'Save changes' }}
            </button>
          </div>
        </div>

        <div v-if="teacher || images.length">
          <div class="section-head">
            <h2>Photos</h2>
            <label v-if="teacher" class="btn ghost sm" style="margin-left:auto">
              {{ uploadingPhoto ? 'Uploading…' : '+ Add photo' }}
              <input type="file" accept="image/*" hidden :disabled="uploadingPhoto"
                     @change="uploadPhoto">
            </label>
          </div>

          <div v-if="images.length" class="gallery">
            <figure v-for="(img, i) in images" :key="img.id" class="gallery-item">
              <img :src="img.url" :alt="img.caption || ''">
              <figcaption v-if="!teacher && img.caption">{{ img.caption }}</figcaption>
              <div v-if="teacher" class="gallery-tools">
                <input type="text" v-model="img.caption" placeholder="Caption (optional)"
                       @change="savePhotoCaption(img)">
                <div class="gallery-btns">
                  <button class="icon-btn" title="Move left" :disabled="i === 0"
                          @click="movePhoto(i, -1)">&larr;</button>
                  <button class="icon-btn" title="Move right" :disabled="i === images.length - 1"
                          @click="movePhoto(i, 1)">&rarr;</button>
                  <button class="icon-btn" title="Remove" @click="deletePhoto(img.id)">&times;</button>
                </div>
              </div>
            </figure>
          </div>
          <p v-else-if="teacher" class="muted small" style="margin:0 0 .5rem">
            No photos yet. Add a few to show on this course's page and its public promo page.
          </p>
        </div>

        <div class="section-head"><h2>Lessons</h2></div>
        <div class="card">
          <div v-for="(lesson, i) in lessons" :key="lesson.id"
               class="lesson-row" :class="{ locked: !lesson.unlocked }">
            <div class="code">{{ lesson.code }}</div>
            <div class="grow">
              <div class="title">{{ lesson.title }}</div>
              <div class="small muted">
                {{ lesson.kind }} · {{ lesson.block_count }} part{{ lesson.block_count === 1 ? '' : 's' }}
              </div>
            </div>
            <span v-if="lesson.completed" class="pill ok">Done</span>
            <span v-else-if="!lesson.unlocked" class="pill">🔒 Locked</span>
            <button class="btn sm" :disabled="!lesson.unlocked && !teacher" @click="openLesson(lesson)">
              {{ teacher ? 'Edit' : (lesson.completed ? 'Review' : 'Start') }}
            </button>
            <button v-if="teacher" class="icon-btn" @click="removeLesson(lesson)">&times;</button>
          </div>
          <p v-if="!lessons.length" class="empty">No lessons yet.</p>
        </div>

        <form v-if="teacher" class="card pad" style="margin-top:.9rem" @submit.prevent="addLesson">
          <div class="row">
            <div class="field" style="flex:2">
              <label>New lesson title</label>
              <input type="text" v-model="newLesson.title" placeholder="Meet the Colours" required>
            </div>
            <div class="field">
              <label>Code</label>
              <input type="text" v-model="newLesson.code" placeholder="1-1">
            </div>
            <div class="field">
              <label>Kind</label>
              <select v-model="newLesson.kind">
                <option>Preview</option><option>Main</option><option>Review</option>
              </select>
            </div>
            <button class="btn shrink" style="margin-bottom:.9rem">+ Add lesson</button>
          </div>
        </form>

        <div class="section-head"><h2>What families say</h2></div>
        <div class="card pad">
          <blockquote v-for="t in testimonials" :key="t.id" class="quote">
            <p>“{{ t.body }}”</p>
            <cite>— {{ t.author_name }}</cite>
            <button v-if="teacher" class="icon-btn" @click="removeTestimonial(t.id)">&times;</button>
          </blockquote>
          <p v-if="!testimonials.length" class="muted small" style="margin:0">No testimonials yet.</p>

          <form v-if="teacher" class="row" style="margin-top:1rem" @submit.prevent="addTestimonial">
            <div class="field">
              <label>Author</label>
              <input type="text" v-model="newTestimonial.author_name" placeholder="Ping's mum" required>
            </div>
            <div class="field" style="flex:2">
              <label>Quote</label>
              <input type="text" v-model="newTestimonial.body" required>
            </div>
            <button class="btn ghost shrink" style="margin-bottom:.9rem">Add</button>
          </form>
        </div>

        <div v-if="teacher" style="margin-top:1.5rem">
          <a class="btn ghost" :href="'#/responses/' + course.id">View student responses &rarr;</a>
        </div>
      </div>
    </div>`,
};

const LessonView = {
  props: ['user'],
  data() {
    return {
      lesson: null, answers: {}, completed: false,
      loading: true, error: '', saving: false, justCompleted: false,
    };
  },
  methods: {
    async load() {
      try {
        const res = await API.get('/lessons/' + route.id);
        this.lesson = res.lesson;
        this.answers = res.answers;
        this.completed = res.completed;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },
    async saveAnswer(answer) {
      try {
        await API.post('/lessons/' + this.lesson.id + '/responses', answer);
        this.answers[answer.block_id] = answer;
      } catch (err) {
        this.error = err.message;
      }
    },
    async complete() {
      this.saving = true;
      try {
        await API.post('/lessons/' + this.lesson.id + '/complete', {});
        this.completed = true;
        this.justCompleted = true;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.saving = false;
      }
    },
  },
  created() { this.load(); },
  template: `
    <div class="page">
      <p v-if="loading" class="empty">Loading…</p>
      <div v-else-if="error" class="alert bad">{{ error }}</div>

      <div v-else-if="lesson" class="lesson-body">
        <div v-if="user.role === 'teacher'" class="preview-note">
          <span>👁 Preview — this is what students see.</span>
          <a class="btn ghost sm shrink" :href="'#/builder/' + lesson.id">&larr; Back to edit</a>
        </div>

        <div class="page-head">
          <div>
            <a class="small muted" :href="'#/course/' + lesson.course_id">&larr; {{ lesson.course_title }}</a>
            <h1 style="margin-top:.35rem">{{ lesson.code }} · {{ lesson.title }}</h1>
          </div>
          <span class="pill shrink" :class="completed ? 'ok' : 'navy'">
            {{ completed ? 'Complete' : lesson.kind }}
          </span>
        </div>

        <block-view v-for="block in lesson.blocks" :key="block.id"
                    :block="block" :answer="answers[block.id]"
                    @answer="saveAnswer"></block-view>

        <p v-if="!lesson.blocks.length" class="empty card">This lesson is empty.</p>

        <div class="complete-bar">
          <div>
            <b v-if="justCompleted">Nice work! The next lesson is unlocked. 🎉</b>
            <b v-else-if="completed">You finished this lesson.</b>
            <b v-else>Finished? Mark it complete to unlock the next lesson.</b>
          </div>
          <div style="display:flex;gap:.5rem">
            <a v-if="user.role === 'teacher'" class="btn ghost"
               :href="'#/builder/' + lesson.id">&larr; Back to edit</a>
            <a class="btn ghost" :href="'#/course/' + lesson.course_id">Back to course</a>
            <button class="btn" :disabled="saving || completed" @click="complete">
              {{ completed ? '✓ Complete' : (saving ? 'Saving…' : 'Mark lesson complete') }}
            </button>
          </div>
        </div>
      </div>
    </div>`,
};

const BuilderView = {
  props: ['user'],
  data() {
    return {
      lesson: null, blocks: [], loading: true, error: '', saved: false, saving: false,
    };
  },
  methods: {
    async load() {
      try {
        const res = await API.get('/lessons/' + route.id);
        this.lesson = res.lesson;
        this.blocks = res.lesson.blocks;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },
    add(type) {
      this.blocks.push(makeBlock(type));
      this.saved = false;
    },
    move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= this.blocks.length) return;
      const [block] = this.blocks.splice(index, 1);
      this.blocks.splice(target, 0, block);
      this.saved = false;
    },
    remove(index) {
      if (!confirm('Delete this part? Any answers to it stay in the database but stop showing.')) return;
      this.blocks.splice(index, 1);
      this.saved = false;
    },
    async save() {
      this.saving = true;
      this.error = '';
      try {
        /* A block with a `key` is an uploaded file (image/audio/video); its `url` is a
           signed link derived on read, so drop it before saving. A video with no key is
           an embed whose `url` IS the link the teacher typed — keep that. */
        const blocks = this.blocks.map((block) => {
          if (block.key) {
            const { url, ...keep } = block;
            return keep;
          }
          return block;
        });
        await API.patch('/lessons/' + this.lesson.id, {
          title: this.lesson.title,
          code: this.lesson.code,
          kind: this.lesson.kind,
          content_json: { blocks },
        });
        this.saved = true;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.saving = false;
      }
    },
  },
  created() { this.load(); },
  template: `
    <div class="page">
      <p v-if="loading" class="empty">Loading…</p>

      <div v-else-if="lesson">
        <div class="page-head">
          <div>
            <a class="small muted" :href="'#/course/' + lesson.course_id">&larr; {{ lesson.course_title }}</a>
            <h1 style="margin-top:.35rem">Lesson builder</h1>
          </div>
          <span v-if="saved" class="saved shrink">✓ Saved</span>
          <a class="btn ghost shrink" :href="'#/lesson/' + lesson.id">Preview</a>
          <button class="btn shrink" :disabled="saving" @click="save">
            {{ saving ? 'Saving…' : 'Save lesson' }}
          </button>
        </div>

        <div v-if="error" class="alert bad">{{ error }}</div>

        <div class="card pad" style="margin-bottom:1.25rem">
          <div class="row">
            <div class="field" style="flex:3;margin:0">
              <label>Lesson title</label>
              <input type="text" v-model="lesson.title">
            </div>
            <div class="field" style="margin:0">
              <label>Code</label>
              <input type="text" v-model="lesson.code">
            </div>
            <div class="field" style="margin:0">
              <label>Kind</label>
              <select v-model="lesson.kind">
                <option>Preview</option><option>Main</option><option>Review</option>
              </select>
            </div>
          </div>
        </div>

        <div class="builder">
          <div>
            <block-editor v-for="(block, i) in blocks" :key="block.id"
                          :block="block" :index="i" :total="blocks.length" :lesson-id="lesson.id"
                          @move="(d) => move(i, d)" @remove="remove(i)"></block-editor>
            <div v-if="!blocks.length" class="card empty">
              Empty lesson. Add your first part from the palette. →
            </div>
          </div>

          <div class="palette card pad">
            <label>Add part</label>
            <button v-for="t in types" :key="t.type" class="btn ghost sm" @click="add(t.type)">
              + {{ t.label }}
            </button>
          </div>
        </div>
      </div>
    </div>`,
  computed: {
    types() { return window.BLOCK_TYPES; },
  },
};

const StudentsView = {
  props: ['user'],
  data() {
    return {
      students: [], courses: [], categories: [], classes: [],
      loading: true, error: '',
      level: '', classFilter: '', q: '', counts: { levels: {}, unassigned: 0 },
      codes: [], showCodes: false,
      newCode: { class_id: '', note: '', max_uses: null },
      newClass: { name: '', category_id: '' },
    };
  },
  computed: {
    /* One level at a time — never "all". The Unassigned tab only exists while
       somebody is actually unassigned. */
    tabs() {
      const tabs = this.categories.map((c) => ({
        id: c.id, name: c.name, count: this.counts.levels[c.id] || 0,
      }));
      if (this.counts.unassigned) {
        tabs.push({ id: 'none', name: 'Unassigned', count: this.counts.unassigned });
      }
      return tabs;
    },
    /* The whole point of the level tabs: only this level's courses become columns. */
    levelCourses() {
      if (this.level === 'none') return [];
      return this.courses.filter((c) => c.category_id === this.level);
    },
    levelClasses() {
      return this.classes.filter((c) => c.category_id === this.level);
    },
    levelName() {
      const tab = this.tabs.find((t) => t.id === this.level);
      return tab ? tab.name : '';
    },
  },
  methods: {
    categoryName(id) {
      const cat = this.categories.find((c) => c.id === id);
      return cat ? cat.name : '—';
    },
    async setLevel(id) {
      this.level = id;
      this.classFilter = '';
      await this.load();
    },
    async load() {
      this.loading = true;
      const params = new URLSearchParams({ level: this.level });
      if (this.classFilter) params.set('class_id', this.classFilter);
      if (this.q) params.set('q', this.q);
      try {
        const res = await API.get('/students?' + params.toString());
        this.students = res.students;
      } catch (err) {
        this.error = err.message;
        this.students = [];
      } finally {
        this.loading = false;
      }
    },
    async refreshCounts() {
      this.counts = await API.get('/students/counts');
    },
    async toggleEnrollment(student, courseId) {
      const enrolled = student.course_ids.includes(courseId);
      try {
        if (enrolled) {
          await API.del('/courses/' + courseId + '/enrollments/' + student.id);
          student.course_ids = student.course_ids.filter((id) => id !== courseId);
        } else {
          await API.post('/courses/' + courseId + '/enrollments', { user_id: student.id });
          student.course_ids.push(courseId);
        }
      } catch (err) {
        this.error = err.message;
      }
    },
    /* Turn a student's access off/on. Off blocks their login; the account and answers
       stay put, so it's fully reversible. */
    async toggleActive(student) {
      const next = !student.active;
      if (!next && !confirm('Turn off access for ' + student.name +
          '? They cannot log in until you turn it back on.')) return;
      try {
        await API.patch('/students/' + student.id, { active: next });
        student.active = next;
      } catch (err) {
        this.error = err.message;
      }
    },
    /* Moving a student to a class in another level makes them leave this tab — that is
       the intended effect. Their course access is left alone. */
    async moveStudent(student, classId) {
      try {
        await API.patch('/students/' + student.id, { class_id: classId || null });
        await this.refreshCounts();
        await this.load();
      } catch (err) {
        this.error = err.message;
        await this.load();
      }
    },
    async loadCodes() {
      this.codes = (await API.get('/invite-codes')).codes;
      this.newCode.class_id = this.levelClasses.length ? this.levelClasses[0].id : '';
      this.newClass.category_id = this.level === 'none'
        ? (this.categories[0] && this.categories[0].id) : this.level;
      this.showCodes = true;
      this.error = '';
    },
    async createClass() {
      this.error = '';
      try {
        const res = await API.post('/classes', this.newClass);
        this.classes = (await API.get('/classes')).classes;
        this.newCode.class_id = res.id;
        this.newClass.name = '';
      } catch (err) {
        this.error = err.message;
      }
    },
    async createCode() {
      this.error = '';
      try {
        await API.post('/invite-codes', this.newCode);
        this.newCode = { class_id: this.newCode.class_id, note: '', max_uses: null };
        this.codes = (await API.get('/invite-codes')).codes;
      } catch (err) {
        this.error = err.message;
      }
    },
    /* The window only lists pending (unused) codes, so the action here is to revoke one
       before anyone uses it — after which it drops off the list. */
    async revokeCode(code) {
      if (!confirm('Revoke ' + code.code + '? It can no longer be used to register.')) return;
      try {
        await API.patch('/invite-codes/' + code.id, { active: false });
        this.codes = this.codes.filter((c) => c.id !== code.id);
      } catch (err) {
        this.error = err.message;
      }
    },
  },
  async created() {
    try {
      const [courses, cats, classes] = await Promise.all([
        API.get('/courses'), API.get('/categories'), API.get('/classes'),
      ]);
      this.courses = courses.courses;
      this.categories = cats.categories;
      this.classes = classes.classes;
      await this.refreshCounts();
      /* Open on a level that actually has students, so the teacher doesn't land on an
         empty table and think something is broken. */
      const populated = this.tabs.find((t) => t.count > 0);
      this.level = populated ? populated.id
        : (this.categories.length ? this.categories[0].id : 'none');
      await this.load();
    } catch (err) {
      this.error = err.message;
      this.loading = false;
    }
  },
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Students</h1>
          <p class="sub">
            {{ students.length }} in {{ levelName || 'this level' }} ·
            tick a course to give access
          </p>
        </div>
        <button class="btn ghost shrink" @click="loadCodes">Classes &amp; codes</button>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>

      <div class="level-tabs">
        <button v-for="t in tabs" :key="t.id" :class="{ on: level === t.id }"
                @click="setLevel(t.id)">
          {{ t.name }}
          <span class="count">{{ t.count }}</span>
        </button>
      </div>

      <div class="card pad" style="margin-bottom:1rem">
        <div class="row">
          <div class="field" style="margin:0">
            <label>Search</label>
            <input type="text" v-model="q" placeholder="Name, email or code" @input="load">
          </div>
          <div class="field" style="margin:0">
            <label>Class</label>
            <select v-model="classFilter" :disabled="level === 'none'" @change="load">
              <option value="">All classes in {{ levelName }}</option>
              <option v-for="c in levelClasses" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card" style="overflow-x:auto">
        <table v-if="students.length" class="assign-table">
          <thead>
            <tr>
              <th class="sticky">Student</th>
              <th>Class</th>
              <th>Code</th>
              <th>Access</th>
              <th>Lessons done</th>
              <th v-for="c in levelCourses" :key="c.id" class="course-col">{{ c.title }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in students" :key="s.id" :class="{ disabled: !s.active }">
              <td class="sticky">
                <b>{{ s.name }}</b>
                <span v-if="!s.active" class="pill red" style="margin-left:.4rem">Off</span>
                <br>
                <span class="small muted">{{ s.email }}</span>
              </td>
              <td>
                <select :value="s.class_id || ''"
                        @change="moveStudent(s, $event.target.value)">
                  <option value="">— none —</option>
                  <optgroup v-for="cat in categories" :key="cat.id" :label="cat.name">
                    <option v-for="c in classes.filter(x => x.category_id === cat.id)"
                            :key="c.id" :value="c.id">{{ c.name }}</option>
                  </optgroup>
                </select>
              </td>
              <td>
                <span v-if="s.invite_code" class="code-chip">{{ s.invite_code }}</span>
                <span v-else class="muted small">—</span>
              </td>
              <td>
                <button class="btn sm" :class="s.active ? 'ghost' : 'danger'"
                        @click="toggleActive(s)">
                  {{ s.active ? 'Turn off' : 'Turn on' }}
                </button>
              </td>
              <td>{{ s.lessons_completed }}</td>
              <td v-for="c in levelCourses" :key="c.id" class="tick">
                <input type="checkbox" :checked="s.course_ids.includes(c.id)"
                       @change="toggleEnrollment(s, c.id)">
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="loading" class="empty">Loading…</p>
        <p v-else class="empty">No students in {{ levelName }}.</p>
      </div>

      <p v-if="level !== 'none' && !levelCourses.length && students.length"
         class="muted small" style="margin-top:.7rem">
        No courses in {{ levelName }} yet — add one and it will appear here as a column.
      </p>

      <div v-if="showCodes" class="modal-backdrop" @click.self="showCodes = false">
        <div class="modal">
          <div class="modal-head">
            <h2>Classes &amp; codes</h2>
            <button class="icon-btn" @click="showCodes = false">&times;</button>
          </div>
          <div class="pad">
            <div v-if="error" class="alert bad">{{ error }}</div>

            <h2 style="margin-top:0;font-size:1rem">Pending invites</h2>
            <p class="muted small" style="margin-top:0">
              Codes that haven't been used yet. A code drops off this list once a student
              registers with it. To stop a student who has already registered, turn their
              access off in the table instead.
            </p>
            <table v-if="codes.length">
              <thead><tr><th>Code</th><th>Class</th><th>Uses</th><th></th></tr></thead>
              <tbody>
                <tr v-for="c in codes" :key="c.id">
                  <td><span class="code-chip">{{ c.code }}</span></td>
                  <td class="small">
                    {{ c.class_name || '—' }}<br>
                    <span class="muted">{{ categoryName(c.category_id) }}</span>
                  </td>
                  <td class="small">{{ c.max_uses ? c.uses + ' / ' + c.max_uses : 'unlimited' }}</td>
                  <td style="text-align:right">
                    <button class="btn ghost sm" @click="revokeCode(c)">Revoke</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted small">No pending codes. Make a class, then a code for it.</p>

            <h2 style="margin-top:1.4rem;font-size:1rem">New code</h2>
            <p class="muted small" style="margin-top:0">
              The class name becomes the code's prefix, and whoever registers with it
              joins that class.
            </p>
            <form class="row" @submit.prevent="createCode">
              <div class="field" style="margin:0">
                <label>Class</label>
                <select v-model="newCode.class_id" required>
                  <option value="" disabled>Pick a class</option>
                  <optgroup v-for="cat in categories" :key="cat.id" :label="cat.name">
                    <option v-for="c in classes.filter(x => x.category_id === cat.id)"
                            :key="c.id" :value="c.id">{{ c.name }}</option>
                  </optgroup>
                </select>
              </div>
              <div class="field" style="margin:0;max-width:100px">
                <label>Max uses</label>
                <input type="number" v-model.number="newCode.max_uses" placeholder="∞" min="1">
              </div>
              <button class="btn shrink" :disabled="!newCode.class_id">New code</button>
            </form>

            <h2 style="margin-top:1.4rem;font-size:1rem">New class</h2>
            <form class="row" @submit.prevent="createClass">
              <div class="field" style="margin:0">
                <label>Name</label>
                <input type="text" v-model="newClass.name" placeholder="Sunflowers" required>
              </div>
              <div class="field" style="margin:0">
                <label>Level</label>
                <select v-model="newClass.category_id" required>
                  <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </div>
              <button class="btn ghost shrink">Add class</button>
            </form>
          </div>
        </div>
      </div>
    </div>`,
};

const ResponsesView = {
  props: ['user'],
  data() {
    return { lessons: [], loading: true, open: null, detail: null, error: '' };
  },
  methods: {
    async openQuiz(lessonId, quiz) {
      this.open = quiz.block_id;
      this.detail = null;
      try {
        this.detail = await API.get(
          '/lessons/' + lessonId + '/blocks/' + quiz.block_id + '/responses');
      } catch (err) {
        this.error = err.message;
        this.open = null;
      }
    },
  },
  async created() {
    try {
      this.lessons = (await API.get('/courses/' + route.id + '/responses')).lessons;
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <a class="small muted" :href="'#/course/' + $root.routeId">&larr; Back to course</a>
          <h1 style="margin-top:.35rem">Responses</h1>
          <p class="sub">Every question in this course, and who has answered it.</p>
        </div>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>
      <p v-if="loading" class="empty">Loading…</p>
      <div v-else-if="!lessons.length" class="card empty">
        No questions in this course yet.
      </div>

      <div v-for="l in lessons" :key="l.lesson_id" class="card" style="margin-bottom:1rem">
        <div class="pad" style="border-bottom:1px solid var(--line)">
          <b>{{ l.lesson_code }} · {{ l.lesson_title }}</b>
        </div>
        <div v-for="q in l.quizzes" :key="q.block_id" class="lesson-row">
          <span class="pill">{{ q.type === 'quiz_mc' ? 'Choice' : (q.type === 'quiz_open' ? 'Open' : 'Upload') }}</span>
          <div class="grow">{{ q.question }}</div>
          <span class="small muted">{{ q.respondents }} answer{{ q.respondents === 1 ? '' : 's' }}</span>
          <button class="btn ghost sm" @click="openQuiz(l.lesson_id, q)">View</button>
        </div>
      </div>

      <div v-if="open" class="modal-backdrop" @click.self="open = null">
        <div class="modal">
          <div class="modal-head">
            <h2>Answers</h2>
            <button class="icon-btn" @click="open = null">&times;</button>
          </div>
          <div class="pad">
            <p v-if="!detail" class="empty">Loading…</p>
            <div v-else>
              <p><b>{{ detail.block.question || detail.block.prompt }}</b></p>
              <table v-if="detail.answers.length">
                <thead><tr><th>Student</th><th>Answer</th></tr></thead>
                <tbody>
                  <tr v-for="a in detail.answers" :key="a.student_id">
                    <td>{{ a.student_name }}</td>
                    <td>
                      <span v-if="a.option_text">
                        {{ a.option_text }}
                        <span class="pill" :class="a.correct ? 'ok' : 'red'">
                          {{ a.correct ? 'Correct' : 'Wrong' }}
                        </span>
                      </span>
                      <span v-else style="white-space:pre-wrap">{{ a.value_text }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="empty">Nobody has answered this yet.</p>
            </div>
          </div>
        </div>
      </div>
    </div>`,
};

/* ------------------------------------------------------------------ public (no login) */

/* What a website visitor sees: promoted courses, for marketing. Read-only, no lesson
   content, and every path funnels toward Sign in / Register. */
const PublicHome = {
  data() { return { groups: [], loading: true, error: '' }; },
  async created() {
    try {
      this.groups = (await API.get('/public/courses')).groups;
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="page">
      <div class="promo-hero card">
        <div class="stripes"><i></i><i></i><i></i></div>
        <div class="pad">
          <h1>Learn English with Mama Lucy</h1>
          <p class="sub">Friendly, step-by-step lessons for adults and children. Browse our
            courses below, then sign in to start learning.</p>
          <a class="btn" href="#/signin">Sign in or register</a>
        </div>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>
      <p v-if="loading" class="empty">Loading…</p>

      <div v-else-if="!groups.length" class="card empty">
        No courses to show yet — please check back soon.
      </div>

      <div v-for="g in groups" :key="g.key">
        <div class="section-head"><h2>{{ g.category_name }}</h2></div>
        <div class="grid">
          <a v-for="c in g.courses" :key="c.id" class="course-card" :href="'#/course/' + c.id">
            <div class="thumb">
              <img v-if="c.title_card_url" :src="c.title_card_url" :alt="c.title">
              <span v-else>🌍</span>
            </div>
            <div class="body">
              <h3>{{ c.title }}</h3>
              <p v-if="c.overview" class="small muted" style="margin:0">
                {{ c.overview.length > 110 ? c.overview.slice(0, 110) + '…' : c.overview }}
              </p>
            </div>
          </a>
        </div>
      </div>
    </div>`,
};

const PublicCourse = {
  data() {
    return { course: null, lessons: [], testimonials: [], images: [], loading: true, error: '' };
  },
  async created() {
    try {
      const res = await API.get('/public/courses/' + route.id);
      this.course = res.course;
      this.lessons = res.lessons;
      this.testimonials = res.testimonials;
      this.images = res.images || [];
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="page">
      <p v-if="loading" class="empty">Loading…</p>
      <div v-else-if="error" class="alert bad">
        {{ error }} <a href="#/">← Back to courses</a>
      </div>

      <div v-else-if="course">
        <a class="small muted" href="#/">← All courses</a>

        <div class="hero" style="margin-top:.5rem">
          <div class="thumb">
            <img v-if="course.title_card_url" :src="course.title_card_url" :alt="course.title">
            <span v-else>🌍</span>
          </div>
          <div>
            <h1>{{ course.title }}</h1>
            <p style="white-space:pre-wrap">{{ course.overview }}</p>
            <div v-if="course.goals && course.goals.length">
              <h2 style="margin-top:1.25rem;font-size:1.05rem">What you'll be able to do</h2>
              <ul class="goals">
                <li v-for="(goal, i) in course.goals" :key="i">{{ goal }}</li>
              </ul>
            </div>
            <a class="btn" style="margin-top:1.25rem" href="#/signin">Register to start this course</a>
          </div>
        </div>

        <div v-if="images.length">
          <div class="section-head"><h2>Photos</h2></div>
          <div class="gallery">
            <figure v-for="(img, i) in images" :key="i" class="gallery-item">
              <img :src="img.url" :alt="img.caption || ''">
              <figcaption v-if="img.caption">{{ img.caption }}</figcaption>
            </figure>
          </div>
        </div>

        <div v-if="lessons.length">
          <div class="section-head"><h2>What's inside</h2></div>
          <div class="card">
            <div v-for="(l, i) in lessons" :key="i" class="lesson-row">
              <div class="code">{{ l.code }}</div>
              <div class="grow">
                <div class="title">{{ l.title }}</div>
                <div class="small muted">{{ l.kind }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="testimonials.length">
          <div class="section-head"><h2>What families say</h2></div>
          <div class="card pad">
            <blockquote v-for="(t, i) in testimonials" :key="i" class="quote">
              <p>“{{ t.body }}”</p>
              <cite>— {{ t.author_name }}</cite>
            </blockquote>
          </div>
        </div>

        <div class="card pad" style="margin-top:1.5rem;text-align:center">
          <b>Ready to begin?</b>
          <p class="muted small" style="margin:.3rem 0 .8rem">
            Sign in or register with your teacher's code to start these lessons.
          </p>
          <a class="btn" href="#/signin">Sign in or register</a>
        </div>
      </div>
    </div>`,
};

/* ------------------------------------------------------------------ shell */

const app = createApp({
  data() {
    return { user: null, ready: false };
  },
  computed: {
    routeName() { return route.name; },
    routeId() { return route.id; },
    view() {
      const views = {
        home: 'home-view', courses: 'courses-view', course: 'course-view',
        lesson: 'lesson-view', builder: 'builder-view', students: 'students-view',
        responses: 'responses-view',
      };
      return views[route.name] || 'home-view';
    },
    /* Remount the view when the route changes — each view loads on created(). */
    viewKey() { return route.name + '/' + (route.id || ''); },
    /* What a not-logged-in visitor sees. Default is the promo landing; the course route
       shows the public (read-only) course info; #/signin shows the auth form. */
    publicView() {
      if (route.name === 'signin') return 'auth-view';
      if (route.name === 'course') return 'public-course';
      return 'public-home';
    },
  },
  methods: {
    signedIn(user) {
      this.user = user;
      go('/home');
    },
    async signOut() {
      await API.post('/logout', {});
      this.user = null;
      go('/home');
    },
    on(name) { return route.name === name; },
  },
  async created() {
    try {
      this.user = (await API.get('/me')).user;
    } catch (err) {
      this.user = null;
    }
    this.ready = true;
  },
  template: `
    <div v-if="!ready" class="empty" style="padding-top:5rem">Loading…</div>

    <div v-else-if="!user">
      <header class="topbar">
        <div class="topbar-inner">
          <a class="lockup" href="#/">
            <img src="/static/img/logo.png" alt="">
            <span>
              <b>Mama Lucy's</b>
              <span>English Explorers</span>
            </span>
          </a>
          <nav class="nav">
            <a href="#/" :class="{ on: publicView !== 'auth-view' }">Courses</a>
            <a href="#/signin" :class="{ on: publicView === 'auth-view' }">Sign in</a>
          </nav>
        </div>
        <div class="stripes"><i></i><i></i><i></i></div>
      </header>

      <auth-view v-if="publicView === 'auth-view'" :on-signed-in="signedIn"></auth-view>
      <component v-else :is="publicView" :key="viewKey"></component>
    </div>

    <div v-else>
      <header class="topbar">
        <div class="topbar-inner">
          <a class="lockup" href="#/home">
            <img src="/static/img/logo.png" alt="">
            <span>
              <b>Mama Lucy's</b>
              <span>English Explorers</span>
            </span>
          </a>
          <nav class="nav">
            <a href="#/home" :class="{ on: on('home') }">Home</a>
            <a href="#/courses" :class="{ on: on('courses') || on('course') }">Courses</a>
            <a v-if="user.role === 'teacher'" href="#/students"
               :class="{ on: on('students') }">Students</a>
            <span class="whoami">{{ user.name }}</span>
            <a href="#" @click.prevent="signOut">Sign out</a>
          </nav>
        </div>
        <div class="stripes"><i></i><i></i><i></i></div>
      </header>

      <component :is="view" :key="viewKey" :user="user"></component>
    </div>`,
});

app.component('auth-view', AuthView);
app.component('home-view', HomeView);
app.component('courses-view', CoursesView);
app.component('course-view', CourseView);
app.component('lesson-view', LessonView);
app.component('builder-view', BuilderView);
app.component('students-view', StudentsView);
app.component('responses-view', ResponsesView);
app.component('public-home', PublicHome);
app.component('public-course', PublicCourse);
app.component('course-card', CourseCard);
app.component('block-view', window.BlockView);
app.component('block-editor', window.BlockEditor);
app.mount('#app');

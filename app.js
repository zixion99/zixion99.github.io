/**
 * Weekly Task Planner — CPIT 251
 * Plain JavaScript, organized by the classes in Design Specification §5.1.
 * Layers: domain/date helpers → IndexedDB → service → view/dialog → controller.
 * No task information is sent to a server. See docs/DECISIONS.md for resolved
 * differences between the supplied proposal, requirements, and design.
 */

export const Priority = Object.freeze({ HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' });
export const TaskStatus = Object.freeze({ INCOMPLETE: 'Incomplete', COMPLETE: 'Complete' });
export const FilterType = Object.freeze({ ALL: 'All', TODAY: 'Today', COMPLETED: 'Completed', OVERDUE: 'Overdue' });

export class Category {
  constructor(categoryId, name, color) { Object.assign(this, { categoryId, name, color }); }
}

export const CATEGORIES = Object.freeze([
  Object.freeze(new Category(1, 'Personal', '#2563EB')),
  Object.freeze(new Category(2, 'Study', '#15803D')),
  Object.freeze(new Category(3, 'Work', '#B45309')),
]);

/** Local YYYY-MM-DD, deliberately not toISOString(), which uses UTC. */
export function dateKey(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Parse a real calendar date at local noon to avoid midnight/DST surprises. */
export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function shiftDate(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export class Week {
  constructor(date = new Date()) {
    this.start = new Date(date);
    this.start.setHours(12, 0, 0, 0);
    this.start.setDate(this.start.getDate() - this.start.getDay());
  }
  static current(today = new Date()) { return new Week(today); }
  previous() { return new Week(shiftDate(this.start, -7)); }
  next() { return new Week(shiftDate(this.start, 7)); }
  end() { return shiftDate(this.start, 6); }
  days() { return Array.from({ length: 7 }, (_, i) => shiftDate(this.start, i)); }
  contains(date) { return date >= dateKey(this.start) && date <= dateKey(this.end()); }
}

/** Seven selectable dates: the starting date and the following six days. */
export function dateNavigationRange(value) {
  const date = parseDate(value);
  return date ? { first: value, last: dateKey(shiftDate(date, 6)) } : null;
}

export class Task {
  constructor(record) { Object.assign(this, record); }
  isComplete() { return this.status === TaskStatus.COMPLETE; }
  isDueOn(date) { return this.dueDate === date; }
  isOverdue(today) { return !this.isComplete() && this.dueDate < today; }
  isInWeek(week) { return week.contains(this.dueDate); }
}

export class TaskInput {
  constructor(title, dueDate, priority, categoryId) {
    Object.assign(this, { title, dueDate, priority, categoryId });
  }
}

export class TaskValidator {
  /** Return all field errors together (FR-01.7–01.11 and FR-02.4). */
  static validate(input, categories = CATEGORIES) {
    const errors = {};
    if (typeof input.title !== 'string' || !input.title.trim()) errors.title = 'Title is required. It cannot be empty or only spaces.';
    if (!parseDate(input.dueDate)) errors.dueDate = 'Enter a valid calendar date (YYYY-MM-DD).';
    if (!Object.values(Priority).includes(input.priority)) errors.priority = 'Select a priority: High, Medium, or Low.';
    if (!categories.some(category => category.categoryId === input.categoryId)) errors.categoryId = 'Select a category: Personal, Study, or Work.';
    return errors;
  }
}

export class ValidationError extends Error {
  constructor(errors) { super('Correct the highlighted fields.'); this.errors = errors; }
}

export class ProgressSummary {
  constructor(completed, incomplete) { Object.assign(this, { completed, incomplete }); }
}

/** Thin Promise wrapper around the browser's IndexedDB API (A-11/A-15). */
export class PlannerDatabase {
  constructor(name = 'WeeklyTaskPlannerDB') { this.name = name; this.db = null; }

  open() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('This browser does not support IndexedDB. Open the planner in a current browser.'));
        return;
      }
      const request = indexedDB.open(this.name, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        const tasks = database.createObjectStore('tasks', { keyPath: 'taskId', autoIncrement: true });
        tasks.createIndex('dueDate', 'dueDate');
        tasks.createIndex('status', 'status');
        tasks.createIndex('categoryId', 'categoryId');
        const categories = database.createObjectStore('categories', { keyPath: 'categoryId' });
        // Seed once during database creation, not on each application load.
        CATEGORIES.forEach(category => categories.add({ ...category }));
      };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        this.db = request.result;
        this.db.onversionchange = () => this.db.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Close other planner tabs, then reload to open the database.'));
      };
    });
  }

  /** Resolve only after transaction COMMIT, never merely after a request succeeds. */
  run(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('The storage operation was cancelled.'));
      transaction.onerror = () => { /* onabort reports the final transaction failure. */ };
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => { result = request.result; };
    });
  }
  addTask(task) { return this.run('tasks', 'readwrite', store => store.add(task)); }
  putTask(task) { return this.run('tasks', 'readwrite', store => store.put(task)); }
  deleteTask(taskId) { return this.run('tasks', 'readwrite', store => store.delete(taskId)); }
  getTask(taskId) { return this.run('tasks', 'readonly', store => store.get(taskId)); }
  getAllTasks() { return this.run('tasks', 'readonly', store => store.getAll()); }
  getCategories() { return this.run('categories', 'readonly', store => store.getAll()); }
  getTasksByDates(first, last) {
    return this.run('tasks', 'readonly', store => store.index('dueDate').getAll(IDBKeyRange.bound(first, last)));
  }
  getTasksBefore(date) {
    return this.run('tasks', 'readonly', store => store.index('dueDate').getAll(IDBKeyRange.upperBound(date, true)));
  }
  getTasksByStatus(status) {
    return this.run('tasks', 'readonly', store => store.index('status').getAll(status));
  }
}

function sortTasks(records) {
  return records.map(record => new Task(record)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.taskId - b.taskId);
}

/** Only this layer accesses PlannerDatabase. UI code cannot write raw records. */
export class TaskService {
  constructor(database) { this.database = database; this.categories = []; }
  async init() { await this.database.open(); this.categories = await this.database.getCategories(); }
  getCategories() { return this.categories; }
  validate(input) {
    const errors = TaskValidator.validate(input, this.categories);
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return { title: input.title.trim(), dueDate: input.dueDate, priority: input.priority, categoryId: input.categoryId };
  }
  async requireTask(taskId) {
    const task = await this.database.getTask(taskId);
    if (!task) throw new Error('This task no longer exists. The list has been refreshed.');
    return new Task(task);
  }
  async addTask(input) {
    const record = { ...this.validate(input), status: TaskStatus.INCOMPLETE };
    const taskId = await this.database.addTask(record);
    return new Task({ ...record, taskId });
  }
  async updateTask(taskId, input) {
    const fields = this.validate(input);
    const previous = await this.requireTask(taskId);
    const updated = { ...previous, ...fields }; // Preserve ID and completion status.
    await this.database.putTask(updated);
    return new Task(updated);
  }
  deleteTask(taskId) { return this.database.deleteTask(taskId); }
  async setStatus(taskId, status) {
    if (!Object.values(TaskStatus).includes(status)) throw new Error('Invalid completion status.');
    const task = await this.requireTask(taskId);
    await this.database.putTask({ ...task, status });
  }
  async getTasksForWeek(week) { return sortTasks(await this.database.getTasksByDates(dateKey(week.start), dateKey(week.end()))); }
  async getFilteredTasks(filter, today) {
    if (filter === FilterType.TODAY) return sortTasks(await this.database.getTasksByDates(today, today));
    if (filter === FilterType.COMPLETED) return sortTasks(await this.database.getTasksByStatus(TaskStatus.COMPLETE));
    if (filter === FilterType.OVERDUE) return sortTasks(await this.database.getTasksBefore(today)).filter(task => task.isOverdue(today));
    throw new Error('Unknown task filter.');
  }
  async getProgress() {
    const tasks = await this.database.getAllTasks();
    const completed = tasks.filter(task => task.status === TaskStatus.COMPLETE).length;
    return new ProgressSummary(completed, tasks.length - completed);
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // User text is never interpreted as HTML.
  return node;
}
function displayDate(date, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

export class PlannerView {
  constructor() { this.root = document.getElementById('task-list'); this.categories = []; }
  setCategories(categories) { this.categories = categories; }
  renderTask(task) {
    const row = element('li', `task-row${task.isComplete() ? ' is-complete' : ''}`);
    row.dataset.taskId = task.taskId;
    const label = element('label', 'task-title');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.isComplete();
    checkbox.dataset.action = 'toggle';
    checkbox.setAttribute('aria-label', `Mark ${task.title} ${task.isComplete() ? 'incomplete' : 'complete'}`);
    label.append(checkbox, element('span', 'title-text', task.title));
    const category = this.categories.find(item => item.categoryId === task.categoryId);
    const badge = element('span', `category category-${category.name.toLowerCase()}`, category.name);
    const priority = element('span', `priority priority-${task.priority.toLowerCase()}`, `Priority: ${task.priority}`);
    const due = element('time', 'due-date', `Due ${task.dueDate}`);
    due.dateTime = task.dueDate;
    const actions = element('div', 'task-actions');
    for (const action of ['edit', 'delete']) {
      const button = element('button', action, action === 'edit' ? 'Edit' : 'Delete');
      button.type = 'button'; button.dataset.action = action;
      button.setAttribute('aria-label', `${action === 'edit' ? 'Edit' : 'Delete'} ${task.title}`);
      actions.append(button);
    }
    row.append(label, badge, priority, due, actions);
    return row;
  }
  renderWeek(week, tasks, today) {
    const fragment = document.createDocumentFragment();
    for (const day of week.days()) {
      const key = dateKey(day);
      const section = element('section', `day-group${key === today ? ' is-today' : ''}`);
      const heading = element('h3', 'day-heading');
      heading.append(element('span', '', displayDate(day, { weekday: 'long' })));
      const time = element('time', '', displayDate(day)); time.dateTime = key; heading.append(time);
      if (key === today) heading.append(element('span', 'today-label', 'Today'));
      section.append(heading);
      const dailyTasks = tasks.filter(task => task.isDueOn(key));
      if (dailyTasks.length) {
        const list = element('ul', 'task-rows'); dailyTasks.forEach(task => list.append(this.renderTask(task))); section.append(list);
      } else section.append(element('p', 'empty-day', 'No tasks'));
      fragment.append(section);
    }
    this.root.replaceChildren(fragment);
  }
  renderFiltered(filter, tasks) {
    const descriptions = { Today: 'Tasks due today, complete or incomplete', Completed: 'Completed tasks, from all weeks', Overdue: 'Incomplete tasks due before today, from all weeks' };
    const summary = element('p', 'filter-summary', `${filter} filter: ${descriptions[filter]} · ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`);
    this.root.replaceChildren(summary);
    if (tasks.length) {
      const list = element('ul', 'task-rows filtered-list'); tasks.forEach(task => list.append(this.renderTask(task))); this.root.append(list);
    } else {
      const empty = element('div', 'empty-filter');
      empty.append(element('strong', '', 'No matching tasks'), element('span', '', 'This filter will update as your tasks change.'));
      this.root.append(empty);
    }
  }
  renderProgress(summary) {
    document.getElementById('completed-count').textContent = summary.completed;
    document.getElementById('incomplete-count').textContent = summary.incomplete;
  }
  showSaveMessage(text) {
    clearTimeout(this.messageTimer);
    document.getElementById('save-message-text').textContent = text;
    document.getElementById('save-message').hidden = false;
    this.messageTimer = setTimeout(() => this.hideMessage(), 6500);
  }
  hideMessage() { clearTimeout(this.messageTimer); document.getElementById('save-message').hidden = true; }
  showError(message = '') {
    const banner = document.getElementById('app-error'); banner.textContent = message; banner.hidden = !message;
  }
}

export class TaskFormDialog {
  constructor() {
    this.dialog = document.getElementById('task-dialog');
    this.form = document.getElementById('task-form');
    this.editingId = null;
    this.dateRange = null;
    this.previousDay = document.getElementById('previous-day');
    this.nextDay = document.getElementById('next-day');
    this.previousDay.addEventListener('click', () => this.moveDate(-1));
    this.nextDay.addEventListener('click', () => this.moveDate(1));
    // Manual date selection remains unrestricted, including past dates (A-05).
    this.form.elements.dueDate.addEventListener('input', () => this.resetDateNavigation());
  }
  setCategories(categories) {
    const select = this.form.elements.categoryId;
    for (const category of categories) {
      const option = element('option', '', category.name); option.value = category.categoryId; select.append(option);
    }
  }
  openForAdd() { this.open(null); }
  openForEdit(task) { this.open(task); }
  open(task) {
    this.form.reset(); this.showErrors({}); this.editingId = task?.taskId ?? null;
    document.getElementById('dialog-title').textContent = task ? 'Edit task' : 'Add task';
    document.getElementById('save-task').textContent = task ? 'Save changes' : 'Save task';
    if (task) for (const key of ['title', 'dueDate', 'priority', 'categoryId']) this.form.elements[key].value = task[key];
    else this.form.elements.dueDate.value = dateKey();
    this.resetDateNavigation();
    this.dialog.showModal(); this.form.elements.title.focus();
  }
  resetDateNavigation() {
    this.dateRange = dateNavigationRange(this.form.elements.dueDate.value);
    this.updateDateNavigation();
  }
  updateDateNavigation() {
    const field = this.form.elements.dueDate;
    const date = parseDate(field.value);
    document.getElementById('due-weekday').textContent = date
      ? new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(date)
      : '';
    const usable = date && this.dateRange && !field.disabled;
    this.previousDay.disabled = !usable || field.value <= this.dateRange.first;
    this.nextDay.disabled = !usable || field.value >= this.dateRange.last;
  }
  moveDate(direction) {
    const field = this.form.elements.dueDate;
    const current = parseDate(field.value);
    if (!current || !this.dateRange || field.disabled) return;
    const next = dateKey(shiftDate(current, direction));
    if (next < this.dateRange.first || next > this.dateRange.last) return;
    field.value = next;
    this.updateDateNavigation();
  }
  readInput() {
    const fields = this.form.elements;
    return new TaskInput(fields.title.value, fields.dueDate.value, fields.priority.value, fields.categoryId.value ? Number(fields.categoryId.value) : null);
  }
  showErrors(errors, message = '') {
    for (const key of ['title', 'dueDate', 'priority', 'categoryId']) {
      const error = document.getElementById(`${key}-error`);
      error.textContent = errors[key] || ''; error.hidden = !errors[key];
      this.form.elements[key].setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
    }
    const banner = document.getElementById('form-error');
    banner.textContent = message || (Object.keys(errors).length ? 'Task not saved. Correct the highlighted fields.' : '');
    banner.hidden = !banner.textContent;
  }
  close() { this.dialog.close(); }
}

export class PlannerController {
  constructor(service, view, form) {
    Object.assign(this, { service, view, form });
    this.selectedWeek = Week.current(); this.activeFilter = FilterType.ALL; this.busy = false;
    this.lastDate = dateKey();
  }
  async init() {
    await this.service.init();
    this.view.setCategories(this.service.getCategories()); this.form.setCategories(this.service.getCategories());
    this.bindEvents(); await this.refresh();
    document.getElementById('loading').hidden = true;
    document.getElementById('planner-content').hidden = false;
    // Re-evaluate Today/Overdue if the app stays open across local midnight.
    setInterval(() => { if (dateKey() !== this.lastDate) this.perform(() => this.refresh()); }, 30000);
    window.addEventListener('focus', () => this.perform(() => this.refresh()));
  }
  bindEvents() {
    document.getElementById('add-task').addEventListener('click', () => { this.view.hideMessage(); this.form.openForAdd(); });
    document.getElementById('cancel-task').addEventListener('click', () => this.form.close());
    document.getElementById('close-message').addEventListener('click', () => this.view.hideMessage());
    document.getElementById('previous-week').addEventListener('click', () => this.navigateWeek(-1));
    document.getElementById('next-week').addEventListener('click', () => this.navigateWeek(1));
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => this.perform(async () => {
      this.activeFilter = button.dataset.filter; await this.refresh();
    })));
    this.form.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.form.form.addEventListener('submit', event => { event.preventDefault(); this.saveTask(); });
    this.view.root.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const taskId = Number(button.closest('[data-task-id]').dataset.taskId);
      if (button.dataset.action === 'edit') this.perform(async () => this.form.openForEdit(await this.service.requireTask(taskId)));
      if (button.dataset.action === 'delete') this.perform(async () => { await this.service.deleteTask(taskId); await this.refresh(); });
    });
    this.view.root.addEventListener('change', event => {
      if (!event.target.matches('input[data-action="toggle"]')) return;
      const taskId = Number(event.target.closest('[data-task-id]').dataset.taskId);
      const status = event.target.checked ? TaskStatus.COMPLETE : TaskStatus.INCOMPLETE;
      this.perform(async () => { await this.service.setStatus(taskId, status); await this.refresh(); });
    });
  }
  setBusy(busy) {
    this.busy = busy;
    document.querySelectorAll('#planner-content button, #planner-content input, #task-form button, #task-form input, #task-form select').forEach(control => { control.disabled = busy; });
    this.form.updateDateNavigation();
  }
  /** Serialize actions so double clicks cannot duplicate a save or race a redraw. */
  async perform(action) {
    if (this.busy) return;
    const previousFocus = document.activeElement;
    const focusedId = previousFocus?.closest('[data-task-id]')?.dataset.taskId;
    const focusedAction = previousFocus?.dataset.action;
    this.setBusy(true); this.view.showError(); this.view.hideMessage();
    try { await action(); }
    catch (error) {
      this.view.showError(`Could not complete the operation. ${error.message || 'Check browser storage and try again.'}`);
      try { await this.refresh(); } catch { /* Keep the original error visible. */ }
    } finally {
      this.setBusy(false);
      if (this.form.dialog.open) {
        (this.form.dialog.contains(previousFocus) ? previousFocus : this.form.form.elements.title)?.focus();
      } else if (focusedId && focusedAction) {
        (this.view.root.querySelector(`[data-task-id="${focusedId}"] [data-action="${focusedAction}"]`) || document.getElementById('add-task')).focus();
      } else if (previousFocus?.isConnected) previousFocus.focus();
    }
  }
  navigateWeek(direction) {
    return this.perform(async () => {
      this.selectedWeek = direction < 0 ? this.selectedWeek.previous() : this.selectedWeek.next();
      this.activeFilter = FilterType.ALL; await this.refresh();
    });
  }
  fitsCurrentView(task) {
    const today = dateKey();
    if (this.activeFilter === FilterType.TODAY) return task.isDueOn(today);
    if (this.activeFilter === FilterType.COMPLETED) return task.isComplete();
    if (this.activeFilter === FilterType.OVERDUE) return task.isOverdue(today);
    return task.isInWeek(this.selectedWeek);
  }
  async saveTask() {
    if (this.busy) return;
    const input = this.form.readInput();
    const errors = TaskValidator.validate(input, this.service.getCategories());
    this.form.showErrors(errors);
    if (Object.keys(errors).length) { this.form.form.elements[Object.keys(errors)[0]].focus(); return; }
    const editing = this.form.editingId !== null;
    this.setBusy(true); this.view.hideMessage(); this.view.showError();
    let task;
    try {
      task = editing ? await this.service.updateTask(this.form.editingId, input) : await this.service.addTask(input);
    } catch (error) {
      this.form.showErrors(error.errors || {}, error instanceof ValidationError ? '' : `Task not saved. ${error.message || 'Check browser storage and try again.'}`);
      this.setBusy(false); return;
    }
    // Storage is committed. Close the form before refreshing; a read error must
    // not invite a second Save of an already committed task.
    this.form.close();
    try {
      await this.refresh();
      if (!this.fitsCurrentView(task)) {
        const reason = this.activeFilter === FilterType.ALL ? 'It is due in another week' : 'It does not match the current filter';
        this.view.showSaveMessage(`${editing ? 'Changes saved.' : 'Task saved.'} ${reason}, so it is not shown here.`);
      }
    } catch { this.view.showError('Your task was saved, but the list could not refresh. Reload the page.'); }
    finally { this.setBusy(false); document.getElementById('add-task').focus(); }
  }
  async refresh() {
    const today = dateKey();
    const [tasks, progress] = await Promise.all([
      this.activeFilter === FilterType.ALL ? this.service.getTasksForWeek(this.selectedWeek) : this.service.getFilteredTasks(this.activeFilter, today),
      this.service.getProgress(),
    ]);
    // Keep keyboard focus on the same row action where that task remains visible.
    const focused = document.activeElement;
    const focusedRow = focused?.closest('[data-task-id]');
    const focusId = focusedRow?.dataset.taskId, action = focused?.dataset.action;
    document.getElementById('week-label').textContent = `${displayDate(this.selectedWeek.start)} – ${displayDate(this.selectedWeek.end())}`;
    document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === this.activeFilter)));
    document.getElementById('view-description').textContent = this.activeFilter === FilterType.ALL ? 'Your week, day by day' : 'Across all weeks';
    if (this.activeFilter === FilterType.ALL) this.view.renderWeek(this.selectedWeek, tasks, today);
    else this.view.renderFiltered(this.activeFilter, tasks);
    this.view.renderProgress(progress); this.lastDate = today;
    if (focusId && action) (this.view.root.querySelector(`[data-task-id="${focusId}"] [data-action="${action}"]`) || document.getElementById('add-task')).focus();
  }
}

// The guard lets Node's built-in test runner import pure domain classes.
if (typeof document !== 'undefined') {
  // Appearance is independent of task storage and still works if storage fails.
  const themeToggle = document.getElementById('theme-toggle');
  const updateThemeButton = () => themeToggle.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
  updateThemeButton();
  themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    updateThemeButton();
    try { localStorage.setItem('weekly-planner-theme', theme); } catch { /* The toggle still works for this visit. */ }
  });
  const view = new PlannerView();
  const controller = new PlannerController(new TaskService(new PlannerDatabase()), view, new TaskFormDialog());
  controller.init().catch(error => {
    document.getElementById('loading').hidden = true;
    view.showError(`The planner could not open its local database. ${error.message || 'Allow browser storage and reload the page.'}`);
  });
}

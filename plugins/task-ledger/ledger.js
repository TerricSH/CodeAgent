class TaskLedger {
    constructor() {
        this.items = [];
        this._nextOrder = 1;
        this._listeners = [];
    }

    _createId() {
        return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }

    _emit(event, item) {
        for (const fn of this._listeners) {
            try { fn(event, item, this.items); } catch { }
        }
    }

    onChange(fn) {
        this._listeners.push(fn);
    }

    add(title, note = '') {
        const item = {
            id: this._createId(),
            title,
            status: 'pending',
            note,
            order: this._nextOrder++,
        };
        this.items.push(item);
        this._emit('added', item);
        return item;
    }

    addMany(titles) {
        return titles.map(t => this.add(t));
    }

    get(id) {
        return this.items.find(i => i.id === id) || null;
    }

    update(id, changes) {
        const item = this.get(id);
        if (!item) return null;
        if (changes.title !== undefined) item.title = changes.title;
        if (changes.status !== undefined) item.status = changes.status;
        if (changes.note !== undefined) item.note = changes.note;
        this._emit('updated', item);
        return item;
    }

    complete(id, note) {
        return this.update(id, { status: 'completed', ...(note !== undefined ? { note } : {}) });
    }

    block(id, note) {
        return this.update(id, { status: 'blocked', ...(note !== undefined ? { note } : {}) });
    }

    list() {
        return this.items.slice().sort((a, b) => a.order - b.order);
    }

    openItems() {
        return this.items.filter(i => i.status === 'pending' || i.status === 'in_progress');
    }

    hasOpenItems() {
        return this.openItems().length > 0;
    }

    hasItems() {
        return this.items.length > 0;
    }

    clear() {
        this.items = [];
        this._nextOrder = 1;
        this._emit('cleared', null);
    }
}

module.exports = TaskLedger;

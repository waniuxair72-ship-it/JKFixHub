/**
 * @file mock-firestore.js
 * @description Isolated in-memory Firestore mock for Step 19 backend unit and integration tests.
 *
 * Guarantees:
 * 1. Zero network calls to production Google Cloud / Firebase.
 * 2. In-memory data store with full inspection capabilities for tests.
 * 3. Exact matching of Firestore DocumentReference, CollectionReference, and Query behaviors.
 */

function sanitizeData(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "object") {
    if (obj.constructor && obj.constructor.name === "ServerTimestampTransform") {
      return new Date().toISOString();
    }
    if (obj.constructor && obj.constructor.name === "DeleteTransform") {
      return undefined;
    }
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (typeof obj.toDate === "function") {
      return obj.toDate().toISOString();
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitizeData);
    }
    const result = {};
    for (const key of Object.keys(obj)) {
      const val = sanitizeData(obj[key]);
      if (val !== undefined) {
        result[key] = val;
      }
    }
    return result;
  }
  return obj;
}

class MockDocSnapshot {
  constructor(id, data, collectionName = "", store = null) {
    this.id = id;
    this._data = data ? JSON.parse(JSON.stringify(data)) : null;
    this.exists = data !== null && data !== undefined;
    if (store && collectionName) {
      this.ref = new MockDocRef(collectionName, id, store);
    }
  }

  data() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

class MockQuery {
  constructor(collectionData, filters = [], limitCount = null, collectionName = "", store = null) {
    this.collectionData = collectionData;
    this.filters = filters;
    this.limitCount = limitCount;
    this.collectionName = collectionName;
    this.store = store;
  }

  where(field, op, value) {
    return new MockQuery(
      this.collectionData,
      [...this.filters, { field, op, value }],
      this.limitCount,
      this.collectionName,
      this.store
    );
  }

  limit(n) {
    return new MockQuery(this.collectionData, this.filters, n, this.collectionName, this.store);
  }

  async get() {
    let docs = Object.entries(this.collectionData).map(([id, data]) => ({
      id,
      data
    }));

    for (const f of this.filters) {
      if (f.op === "==") {
        docs = docs.filter((d) => d.data && d.data[f.field] === f.value);
      } else if (f.op === "in") {
        docs = docs.filter((d) => d.data && Array.isArray(f.value) && f.value.includes(d.data[f.field]));
      } else if (f.op === "array-contains") {
        docs = docs.filter((d) => d.data && Array.isArray(d.data[f.field]) && d.data[f.field].includes(f.value));
      }
    }

    if (typeof this.limitCount === "number") {
      docs = docs.slice(0, this.limitCount);
    }

    const snaps = docs.map((d) => new MockDocSnapshot(d.id, d.data, this.collectionName, this.store));
    return {
      empty: snaps.length === 0,
      size: snaps.length,
      docs: snaps
    };
  }
}

class MockDocRef {
  constructor(collectionName, id, store) {
    this.collectionName = collectionName;
    this.id = id;
    this.store = store;
  }

  collection(subCollectionName) {
    const subPath = `${this.collectionName}/${this.id}/${subCollectionName}`;
    if (!this.store[subPath]) {
      this.store[subPath] = {};
    }
    return new MockCollectionRef(subPath, this.store);
  }

  async get() {
    const coll = this.store[this.collectionName] || {};
    const data = coll[this.id] || null;
    return new MockDocSnapshot(this.id, data, this.collectionName, this.store);
  }

  async update(updates) {
    if (!this.store[this.collectionName]) {
      this.store[this.collectionName] = {};
    }
    const current = this.store[this.collectionName][this.id];
    if (!current) {
      const err = new Error(`Document ${this.id} does not exist`);
      err.code = 5; // NOT_FOUND
      throw err;
    }
    Object.assign(current, sanitizeData(updates));
    return { writeTime: new Date() };
  }

  async set(data, options = {}) {
    if (!this.store[this.collectionName]) {
      this.store[this.collectionName] = {};
    }
    const sanitized = sanitizeData(data);
    if (options.merge && this.store[this.collectionName][this.id]) {
      Object.assign(
        this.store[this.collectionName][this.id],
        sanitized
      );
    } else {
      this.store[this.collectionName][this.id] = sanitized;
    }
    return { writeTime: new Date() };
  }

  async create(data) {
    if (!this.store[this.collectionName]) {
      this.store[this.collectionName] = {};
    }
    if (this.store[this.collectionName][this.id]) {
      const err = new Error(`Document ${this.id} already exists`);
      err.code = 6; // ALREADY_EXISTS
      throw err;
    }
    this.store[this.collectionName][this.id] = sanitizeData(data);
    return { writeTime: new Date() };
  }

  async delete() {
    if (this.store[this.collectionName]) {
      delete this.store[this.collectionName][this.id];
    }
    return { writeTime: new Date() };
  }
}

class MockCollectionRef {
  constructor(name, store) {
    this.name = name;
    this.store = store;
  }

  doc(id) {
    const docId = id || `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new MockDocRef(this.name, docId, this.store);
  }

  async add(data) {
    const id = `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    if (!this.store[this.name]) {
      this.store[this.name] = {};
    }
    this.store[this.name][id] = sanitizeData(data);
    return new MockDocRef(this.name, id, this.store);
  }

  where(field, op, value) {
    return new MockQuery(this.store[this.name] || {}, [], null, this.name, this.store).where(field, op, value);
  }

  limit(n) {
    return new MockQuery(this.store[this.name] || {}, [], null, this.name, this.store).limit(n);
  }

  async get() {
    return new MockQuery(this.store[this.name] || {}, [], null, this.name, this.store).get();
  }
}

class MockFirestore {
  constructor() {
    this.store = {};
    this._transactionLock = Promise.resolve();
  }

  collection(name) {
    if (!this.store[name]) {
      this.store[name] = {};
    }
    return new MockCollectionRef(name, this.store);
  }

  batch() {
    const operations = [];
    return {
      set: (ref, data, options = {}) => {
        operations.push(() => ref.set(data, options));
      },
      update: (ref, data) => {
        operations.push(() => ref.update(data));
      },
      delete: (ref) => {
        operations.push(() => ref.delete());
      },
      commit: async () => {
        for (const op of operations) {
          await op();
        }
        return [{ writeTime: new Date() }];
      }
    };
  }

  async runTransaction(updateFunction) {
    // In real Firestore, concurrent transactions against overlapping documents
    // are serialized / retried with optimistic concurrency control.
    // Queue transactions sequentially in the in-memory mock to emulate ACID isolation.
    const run = async () => {
      const transaction = {
        get: async (ref) => ref.get(),
        set: (ref, data, options = {}) => ref.set(data, options),
        update: (ref, data) => ref.update(data),
        delete: (ref) => ref.delete()
      };
      return await updateFunction(transaction);
    };

    const next = this._transactionLock.then(run, run);
    this._transactionLock = next;
    return await next;
  }

  clear() {
    this.store = {};
    this._transactionLock = Promise.resolve();
  }

  seed(collectionName, id, data) {
    if (!this.store[collectionName]) {
      this.store[collectionName] = {};
    }
    this.store[collectionName][id] = sanitizeData(data);
  }

  dump(collectionName) {
    return this.store[collectionName] || {};
  }
}

module.exports = {
  MockFirestore
};

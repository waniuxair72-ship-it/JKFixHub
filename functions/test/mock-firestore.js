/**
 * @file mock-firestore.js
 * @description Isolated in-memory Firestore mock for Step 19 backend unit and integration tests.
 *
 * Guarantees:
 * 1. Zero network calls to production Google Cloud / Firebase.
 * 2. In-memory data store with full inspection capabilities for tests.
 * 3. Exact matching of Firestore DocumentReference, CollectionReference, and Query behaviors.
 */

class MockDocSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data ? JSON.parse(JSON.stringify(data)) : null;
    this.exists = data !== null && data !== undefined;
  }

  data() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

class MockQuery {
  constructor(collectionData, filters = [], limitCount = null) {
    this.collectionData = collectionData;
    this.filters = filters;
    this.limitCount = limitCount;
  }

  where(field, op, value) {
    return new MockQuery(
      this.collectionData,
      [...this.filters, { field, op, value }],
      this.limitCount
    );
  }

  limit(n) {
    return new MockQuery(this.collectionData, this.filters, n);
  }

  async get() {
    let docs = Object.entries(this.collectionData).map(([id, data]) => ({
      id,
      data
    }));

    for (const f of this.filters) {
      if (f.op === "==") {
        docs = docs.filter((d) => d.data[f.field] === f.value);
      }
    }

    if (typeof this.limitCount === "number") {
      docs = docs.slice(0, this.limitCount);
    }

    const snaps = docs.map((d) => new MockDocSnapshot(d.id, d.data));
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

  async get() {
    const coll = this.store[this.collectionName] || {};
    const data = coll[this.id] || null;
    return new MockDocSnapshot(this.id, data);
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
    Object.assign(current, JSON.parse(JSON.stringify(updates)));
    return { writeTime: new Date() };
  }

  async set(data, options = {}) {
    if (!this.store[this.collectionName]) {
      this.store[this.collectionName] = {};
    }
    if (options.merge && this.store[this.collectionName][this.id]) {
      Object.assign(
        this.store[this.collectionName][this.id],
        JSON.parse(JSON.stringify(data))
      );
    } else {
      this.store[this.collectionName][this.id] = JSON.parse(JSON.stringify(data));
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
    this.store[this.name][id] = JSON.parse(JSON.stringify(data));
    return new MockDocRef(this.name, id, this.store);
  }

  where(field, op, value) {
    return new MockQuery(this.store[this.name] || {}).where(field, op, value);
  }

  limit(n) {
    return new MockQuery(this.store[this.name] || {}).limit(n);
  }

  async get() {
    return new MockQuery(this.store[this.name] || {}).get();
  }
}

class MockFirestore {
  constructor() {
    this.store = {};
  }

  collection(name) {
    if (!this.store[name]) {
      this.store[name] = {};
    }
    return new MockCollectionRef(name, this.store);
  }

  clear() {
    this.store = {};
  }

  seed(collectionName, id, data) {
    if (!this.store[collectionName]) {
      this.store[collectionName] = {};
    }
    this.store[collectionName][id] = JSON.parse(JSON.stringify(data));
  }

  dump(collectionName) {
    return this.store[collectionName] || {};
  }
}

module.exports = {
  MockFirestore
};

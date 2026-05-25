class FormData {
  constructor() {
    this._data = {};
  }
  append(key, value, options) {
    this._data[key] = { value, options };
  }
  getHeaders() {
    return { 'content-type': 'multipart/form-data' };
  }
}

module.exports = FormData;

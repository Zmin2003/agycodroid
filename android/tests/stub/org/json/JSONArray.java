package org.json;

// 测试桩：见 JSONObject.java 的说明（桌面 JVM 上 android.jar 的 org.json 是空壳）。
public class JSONArray {
    final java.util.List<Object> list = new java.util.ArrayList<>();

    public JSONArray() {}
    public JSONArray(java.util.Collection<?> c) {
        if (c != null) for (Object o : c) list.add(JSONObject.wrap(o));
    }
    public JSONArray(String json) throws JSONException {
        Object v = new JSONObject.Parser(json).parseValue();
        if (!(v instanceof JSONArray)) throw new JSONException("not an array");
        list.addAll(((JSONArray) v).list);
    }

    public JSONArray put(Object v) { list.add(v == JSONObject.NULL ? null : JSONObject.wrap(v)); return this; }
    public JSONArray put(int v) { list.add(v); return this; }
    public JSONArray put(long v) { list.add(v); return this; }
    public JSONArray put(boolean v) { list.add(v); return this; }

    public int length() { return list.size(); }
    public Object opt(int i) { return i >= 0 && i < list.size() ? list.get(i) : null; }
    public String optString(int i) { return optString(i, ""); }
    public String optString(int i, String dflt) {
        Object v = opt(i);
        if (v == null) return dflt;
        return v instanceof String ? (String) v : String.valueOf(v);
    }
    public int optInt(int i) { return optInt(i, 0); }
    public int optInt(int i, int dflt) {
        Object v = opt(i);
        return v instanceof Number ? ((Number) v).intValue() : dflt;
    }
    public JSONObject optJSONObject(int i) {
        Object v = opt(i);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }
    public JSONArray optJSONArray(int i) {
        Object v = opt(i);
        return v instanceof JSONArray ? (JSONArray) v : null;
    }
    public String getString(int i) throws JSONException {
        Object v = opt(i);
        if (v == null) throw new JSONException("no value at " + i);
        return v instanceof String ? (String) v : String.valueOf(v);
    }
    public JSONObject getJSONObject(int i) throws JSONException {
        Object v = opt(i);
        if (v instanceof JSONObject) return (JSONObject) v;
        throw new JSONException("not an object at " + i);
    }

    @Override public String toString() {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            JSONObject.writeValue(sb, list.get(i));
        }
        return sb.append(']').toString();
    }
}

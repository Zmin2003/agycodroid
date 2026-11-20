package org.json;

// 测试桩：桌面 JVM 上 android.jar 里的 org.json 全是抛 Stub! 的空壳，
// new JSONObject() / optString() 这些在测试里根本跑不起来。
// 这里是一份最小但真的实现（对象按插入顺序、标准 JSON 解析与序列化），
// 只给 scripts/java-tests.sh 用（真机 / 打包时仍是系统的 org.json）。
// 口径照公开的 org.json：缺失的键 opt* 给默认值、get* 抛 JSONException、
// JSONObject.NULL 序列化成 null、optString(NUL) 给 ""。
public class JSONObject {
    public static final Object NULL = new Object() {
        @Override public String toString() { return "null"; }
        @Override public boolean equals(Object o) { return o == this || o == null; }
    };

    private final java.util.LinkedHashMap<String, Object> map = new java.util.LinkedHashMap<>();

    public JSONObject() {}
    public JSONObject(java.util.Map<?, ?> m) {
        if (m != null) for (java.util.Map.Entry<?, ?> e : m.entrySet())
            map.put(String.valueOf(e.getKey()), wrap(e.getValue()));
    }
    public JSONObject(String json) throws JSONException {
        Object v = new Parser(json).parseValue();
        if (!(v instanceof JSONObject)) throw new JSONException("not an object");
        map.putAll(((JSONObject) v).map);
    }

    static Object wrap(Object o) {
        if (o == null || o == NULL) return null;
        if (o instanceof java.util.Map) return new JSONObject((java.util.Map<?, ?>) o);
        if (o instanceof java.util.Collection) return new JSONArray((java.util.Collection<?>) o);
        if (o instanceof Object[]) return new JSONArray(java.util.Arrays.asList((Object[]) o));
        return o;
    }

    public JSONObject put(String k, Object v) throws JSONException {
        if (k == null) throw new JSONException("null key");
        map.put(k, v == NULL ? null : wrap(v));
        return this;
    }
    public JSONObject put(String k, int v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, long v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, double v) throws JSONException { map.put(k, v); return this; }
    public JSONObject put(String k, boolean v) throws JSONException { map.put(k, v); return this; }

    public boolean has(String k) { return map.containsKey(k); }
    /** 没有这个键、或值是 NULL 都算 null（公开 org.json 的口径） */
    public boolean isNull(String k) { return !map.containsKey(k) || map.get(k) == null; }
    public Object remove(String k) { return map.remove(k); }
    public java.util.Iterator<String> keys() { return map.keySet().iterator(); }
    public java.util.Set<String> keySet() { return map.keySet(); }
    public int length() { return map.size(); }

    public Object opt(String k) { return map.get(k); }
    public String optString(String k) { return optString(k, ""); }
    public String optString(String k, String dflt) {
        Object v = map.get(k);
        if (v == null) return dflt;
        return v instanceof String ? (String) v : String.valueOf(v);
    }
    public int optInt(String k) { return optInt(k, 0); }
    public int optInt(String k, int dflt) {
        Object v = map.get(k);
        if (v instanceof Number) return ((Number) v).intValue();
        if (v instanceof String) { try { return Integer.parseInt((String) v); } catch (NumberFormatException ignored) {} }
        return dflt;
    }
    public long optLong(String k) { return optLong(k, 0L); }
    public long optLong(String k, long dflt) {
        Object v = map.get(k);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) { try { return Long.parseLong((String) v); } catch (NumberFormatException ignored) {} }
        return dflt;
    }
    public boolean optBoolean(String k) { return optBoolean(k, false); }
    public boolean optBoolean(String k, boolean dflt) {
        Object v = map.get(k);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) { String s = (String) v; if ("true".equalsIgnoreCase(s)) return true; if ("false".equalsIgnoreCase(s)) return false; }
        return dflt;
    }
    public double optDouble(String k) { return optDouble(k, Double.NaN); }
    public double optDouble(String k, double dflt) {
        Object v = map.get(k);
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v instanceof String) { try { return Double.parseDouble((String) v); } catch (NumberFormatException ignored) {} }
        return dflt;
    }
    public JSONObject optJSONObject(String k) {
        Object v = map.get(k);
        return v instanceof JSONObject ? (JSONObject) v : null;
    }
    public JSONArray optJSONArray(String k) {
        Object v = map.get(k);
        return v instanceof JSONArray ? (JSONArray) v : null;
    }

    public Object get(String k) throws JSONException {
        if (!map.containsKey(k)) throw new JSONException("no such key: " + k);
        return map.get(k);
    }
    public String getString(String k) throws JSONException {
        Object v = get(k);
        if (v == null) throw new JSONException("null value: " + k);
        return v instanceof String ? (String) v : String.valueOf(v);
    }
    public int getInt(String k) throws JSONException {
        Object v = get(k);
        if (v instanceof Number) return ((Number) v).intValue();
        throw new JSONException("not a number: " + k);
    }
    public long getLong(String k) throws JSONException {
        Object v = get(k);
        if (v instanceof Number) return ((Number) v).longValue();
        throw new JSONException("not a number: " + k);
    }
    public boolean getBoolean(String k) throws JSONException {
        Object v = get(k);
        if (v instanceof Boolean) return (Boolean) v;
        throw new JSONException("not a boolean: " + k);
    }
    public JSONObject getJSONObject(String k) throws JSONException {
        Object v = get(k);
        if (v instanceof JSONObject) return (JSONObject) v;
        throw new JSONException("not an object: " + k);
    }
    public JSONArray getJSONArray(String k) throws JSONException {
        Object v = get(k);
        if (v instanceof JSONArray) return (JSONArray) v;
        throw new JSONException("not an array: " + k);
    }

    @Override public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (java.util.Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(quote(e.getKey())).append(':');
            writeValue(sb, e.getValue());
        }
        return sb.append('}').toString();
    }

    /** 带缩进的序列化（生产代码里 Updater.status().toString(1) 在用；测试桩只求可读，不严格对齐） */
    public String toString(int indent) {
        if (indent <= 0) return toString();
        StringBuilder sb = new StringBuilder("{\n");
        String pad = " ".repeat(indent);
        boolean first = true;
        for (java.util.Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(",\n");
            first = false;
            sb.append(pad).append(quote(e.getKey())).append(": ");
            writeValue(sb, e.getValue());
        }
        return sb.append('\n').append('}').toString();
    }

    static void writeValue(StringBuilder sb, Object v) {
        if (v == null) sb.append("null");
        else if (v instanceof String) sb.append(quote((String) v));
        else if (v instanceof JSONObject || v instanceof JSONArray) sb.append(v.toString());
        else if (v instanceof Number || v instanceof Boolean) sb.append(v);
        else sb.append(quote(String.valueOf(v)));
    }

    /** 公开 org.json 的 quote：字符串包上双引号并转义（生产代码 MainActivity 在用） */
    public static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** 最小 JSON 解析器：对象、数组、字符串（含转义与 U+XXXX）、数字、true/false/null */
    static final class Parser {
        private final String s;
        private int i;
        Parser(String s) { this.s = s == null ? "" : s; }
        Object parseValue() throws JSONException {
            skipWs();
            if (i >= s.length()) throw new JSONException("empty input");
            char c = s.charAt(i);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't') { expect("true"); return Boolean.TRUE; }
            if (c == 'f') { expect("false"); return Boolean.FALSE; }
            if (c == 'n') { expect("null"); return null; }
            return parseNumber();
        }
        private JSONObject parseObject() throws JSONException {
            JSONObject o = new JSONObject();
            i++; skipWs();
            if (peek() == '}') { i++; return o; }
            while (true) {
                skipWs();
                if (peek() != '"') throw new JSONException("expected string key at " + i);
                String k = parseString();
                skipWs();
                if (peek() != ':') throw new JSONException("expected ':' at " + i);
                i++;
                o.map.put(k, wrap(parseValue()));
                skipWs();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == '}') { i++; return o; }
                throw new JSONException("expected ',' or '}' at " + i);
            }
        }
        private JSONArray parseArray() throws JSONException {
            JSONArray a = new JSONArray();
            i++; skipWs();
            if (peek() == ']') { i++; return a; }
            while (true) {
                a.list.add(wrap(parseValue()));
                skipWs();
                char c = peek();
                if (c == ',') { i++; continue; }
                if (c == ']') { i++; return a; }
                throw new JSONException("expected ',' or ']' at " + i);
            }
        }
        private String parseString() throws JSONException {
            if (s.charAt(i) != '"') throw new JSONException("expected '\"' at " + i);
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (i >= s.length()) break;
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (i + 4 > s.length()) throw new JSONException("bad \\u escape");
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: throw new JSONException("bad escape \\" + e);
                    }
                } else sb.append(c);
            }
            throw new JSONException("unterminated string");
        }
        private Number parseNumber() throws JSONException {
            int from = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(from, i);
            try {
                if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
                return Long.parseLong(n);
            } catch (NumberFormatException e) { throw new JSONException("bad number: " + n); }
        }
        private void expect(String lit) throws JSONException {
            if (!s.startsWith(lit, i)) throw new JSONException("expected " + lit + " at " + i);
            i += lit.length();
        }
        private void skipWs() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        private char peek() { return i < s.length() ? s.charAt(i) : '\0'; }
    }
}

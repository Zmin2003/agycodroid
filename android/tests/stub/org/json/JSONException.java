package org.json;

// 测试桩：见 JSONObject.java 的说明。
public class JSONException extends Exception {
    public JSONException(String msg) { super(msg); }
    public JSONException(String msg, Throwable cause) { super(msg, cause); }
}

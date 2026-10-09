package br.com.farohq;

/** JSON mínimo (sem dependência): só strings e nulos, que é tudo que o evento precisa. */
final class Json {

    private Json() {
    }

    static StringBuilder field(StringBuilder sb, String name, String value) {
        string(sb, name).append(':');
        if (value == null) {
            return sb.append("null");
        }
        return string(sb, value);
    }

    static StringBuilder string(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                sb.append("\\\"");
            } else if (c == '\\') {
                sb.append("\\\\");
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else if (c < 0x20) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        return sb.append('"');
    }
}

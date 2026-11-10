// One planted secret per redaction category. Every string is assembled at
// runtime so no secret scanner flags this file. Each row is
// [category, text, needle that must not survive (default: text)].
export const SECRETS = [
  ['anthropic', 'sk-' + 'ant-' + 'A1b2'.repeat(6)], ['github', 'gh' + 'p_' + 'Z9y8'.repeat(9)],
  ['github pat', 'github_' + 'pat_' + '11AB'.repeat(6) + '_cd34'], ['slack', 'xo' + 'xb-' + '1234567890-abcdefABCDEF'],
  ['aws', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'], ['jwt', 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYW5lbCJ9.c2lnbmF0dXJlX2Zha2U'],
  ['pem', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow' + 'x'.repeat(60) + '\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ['bearer', 'Authorization: Bearer ' + 'q'.repeat(12) + '.Rt5', 'q'.repeat(12)],
  ['assignment', 'API_TOKEN=' + 'hunter2hunter2', 'hunter2hunter2'], ['password', 'password: "' + 'correct-horse' + '"', 'correct-horse'],
  ['hex', '0123456789abcdef'.repeat(2) + 'ff'], ['base64', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ' + 'Zm9vYmFyYmF6cXV4MTIz'],
  // key/value secrets in the forms transcripts and shell commands actually carry
  ['json password', '{"password": "' + 'hunter2hunter2' + '"}', 'hunter2hunter2'],
  ['json api_key', '{"api_key":"' + 'abcd1234efgh' + '"}', 'abcd1234efgh'],
  ['json token', '{"token": "' + 'zq81kd7wm3xp0' + '"}', 'zq81kd7wm3xp0'],
  ['escaped json', '{\\"password\\": \\"' + 'hunter2hunter2' + '\\"}', 'hunter2hunter2'],
  ['spaced passphrase', 'PASSWORD="' + 'correct horse battery staple' + '"', 'horse battery staple'],
  ['single-quoted spaces', "token: '" + 'abc def ghi' + "'", 'abc def ghi'],
  ['separator in value', 'password=' + 'p@ss;word123', 'word123'],
  ['unterminated quote', 'secret: "' + 'hunter2hunter2 and more', 'hunter2hunter2'],
];

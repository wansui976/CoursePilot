-- 下载时请求了字幕却没拿到的原因：skipped 这一集没有该语言的轨 | rateLimited 一直被限流 |
-- failed 别的原因没下成（登录失效、网络、超时）。文稿页据此说明「文稿是语音识别生成的」，
-- 用户点掉或之后导入了字幕就清空。只是本机的下载记录，不在同步触发器的列里，不进同步。
ALTER TABLE videos ADD COLUMN subtitle_missing TEXT;

-- 黑边探测改成采样正片多处后取最小值（只看开头 60 秒会被片头/标题卡带偏，
-- 照着片头的黑边去裁会把正片的真实画面削掉一条）。已存的探测值是按老办法算的，
-- 清空让它们按新办法重测一次；重测结果照旧缓存，不会每次打开都重跑。
UPDATE videos
SET crop_top = NULL, crop_right = NULL, crop_bottom = NULL, crop_left = NULL;

-- 视频自带黑边的裁剪量：四边各占整帧的比例（0~1 小数），导入时用 ffmpeg
-- cropdetect 探测得到。NULL 表示未探测或无黑边。播放器据此做非破坏式显示裁剪。
ALTER TABLE videos ADD COLUMN crop_top REAL;
ALTER TABLE videos ADD COLUMN crop_right REAL;
ALTER TABLE videos ADD COLUMN crop_bottom REAL;
ALTER TABLE videos ADD COLUMN crop_left REAL;

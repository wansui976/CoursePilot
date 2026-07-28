//! Apple Vision OCR for macOS and iOS.

use crate::error::{AppError, AppResult};
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{
    VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
    VNRequestTextRecognitionLevel,
};
use std::path::Path;

struct OcrLine {
    text: String,
    x: f64,
    y: f64,
}

/// Recognize simplified Chinese and English text without leaving the device.
///
/// Vision objects are not Send/Sync, so callers must keep this whole synchronous
/// operation on one thread. `ocr::run_ocr_on_image` provides that boundary with
/// `spawn_blocking` and only returns the resulting String.
pub fn recognize_text(path: &Path) -> AppResult<String> {
    if !path.is_file() {
        return Err(AppError::NotFound(format!("OCR image {}", path.display())));
    }

    autoreleasepool(|_| {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);

        let languages = ["zh-Hans", "en-US"]
            .iter()
            .map(|language| NSString::from_str(language))
            .collect::<Vec<_>>();
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&languages));

        let image_path = NSString::from_str(&path.to_string_lossy());
        let image_url = NSURL::fileURLWithPath(&image_path);
        let options = NSDictionary::<VNImageOption, AnyObject>::new();
        let handler = unsafe {
            VNImageRequestHandler::initWithURL_options(
                VNImageRequestHandler::alloc(),
                &image_url,
                &options,
            )
        };
        let requests = NSArray::<VNRequest>::from_slice(&[request.as_ref()]);
        handler
            .performRequests_error(&requests)
            .map_err(|error| AppError::Pipeline(format!("Apple Vision OCR failed: {error}")))?;

        let observations = request
            .results()
            .ok_or_else(|| AppError::Pipeline("Apple Vision returned no results".into()))?;
        let mut lines = Vec::with_capacity(observations.count());
        for index in 0..observations.count() {
            let observation = observations.objectAtIndex(index);
            let candidates = observation.topCandidates(1);
            let Some(candidate) = candidates.firstObject() else {
                continue;
            };
            let bounds = unsafe { observation.boundingBox() };
            lines.push(OcrLine {
                text: candidate.string().to_string(),
                x: bounds.origin.x,
                y: bounds.origin.y,
            });
        }

        // Vision coordinates start at the bottom-left. Rebuild normal reading
        // order: top-to-bottom, and left-to-right for observations on one row.
        lines.sort_by(|left, right| {
            right
                .y
                .total_cmp(&left.y)
                .then_with(|| left.x.total_cmp(&right.x))
        });
        Ok(lines
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_image_returns_not_found_before_calling_vision() {
        let result = recognize_text(Path::new("/definitely-missing-course-ai-ocr.png"));
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}

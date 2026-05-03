use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionPlannerRequest {
    title: String,
    bpm: f64,
    musical_key: String,
    duration_seconds: f64,
    detected_phrase_bars: u32,
    intro_bars: u32,
    outro_bars: u32,
    genre: String,
    energy_profile: String,
    preserve_vocals: bool,
    operation_mode: String,
    style_preset: String,
    vocal_handling: String,
    take_count: u32,
    analysis_overall_score: Option<f64>,
    analysis_production_ready: Option<bool>,
    downbeat_offset_seconds: Option<f64>,
    downbeat_confidence: Option<f64>,
    marker_count: Option<u32>,
    stem_package_ready: Option<bool>,
    stem_engine: Option<String>,
    stem_package_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSegment {
    label: String,
    start_bar: u32,
    end_bar: u32,
    energy: String,
    treatment: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanTake {
    take_index: u32,
    label: String,
    variation_focus: String,
    render_notes: Vec<String>,
    export_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionPlannerResponse {
    project_title: String,
    source_title: String,
    estimated_total_bars: u32,
    intro_bars: u32,
    outro_bars: u32,
    quantized_intro_bars: u32,
    quantized_outro_bars: u32,
    recommended_source_entry_bar: u32,
    recommended_outro_start_bar: u32,
    planner_quality_score: f64,
    intro_duration_seconds: f64,
    outro_duration_seconds: f64,
    total_export_duration_seconds: f64,
    intro_sections: Vec<PlanSegment>,
    outro_sections: Vec<PlanSegment>,
    takes: Vec<PlanTake>,
    warnings: Vec<String>,
    engineer_notes: Vec<String>,
    export_label: String,
}

fn bars_to_seconds(bpm: f64, bars: u32) -> f64 {
    (240.0 / bpm) * bars as f64
}

fn rounded_duration(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn quantize_bars_to_phrase(requested_bars: u32, phrase_bars: u32) -> u32 {
    if phrase_bars == 0 {
        return requested_bars;
    }

    let lower = (requested_bars / phrase_bars) * phrase_bars;
    let upper = lower + phrase_bars;

    if lower == 0 {
        return upper.max(phrase_bars);
    }

    if requested_bars - lower <= upper - requested_bars {
        lower
    } else {
        upper
    }
}

fn energy_lane(profile: &str, stage: usize, is_intro: bool) -> String {
    let intro_map = match profile {
        "warmup" => ["low", "low-mid", "mid", "mid"],
        "afterhours" => ["low", "mid", "mid", "mid-high"],
        _ => ["low-mid", "mid", "mid-high", "high"],
    };

    let outro_map = match profile {
        "warmup" => ["mid", "mid-low", "low", "low"],
        "afterhours" => ["mid-high", "mid", "mid-low", "low"],
        _ => ["high", "mid-high", "mid", "low-mid"],
    };

    let map = if is_intro { intro_map } else { outro_map };
    map[stage].to_string()
}

fn split_sections(total_bars: u32) -> [u32; 4] {
    let base = total_bars / 4;
    let remainder = total_bars % 4;
    let mut sections = [base; 4];

    for section in sections.iter_mut().take(remainder as usize) {
        *section += 1;
    }

    sections
}

fn build_intro_sections(request: &ExtensionPlannerRequest, intro_bars: u32) -> Vec<PlanSegment> {
    if intro_bars == 0 {
        return Vec::new();
    }

    let parts = split_sections(intro_bars);
    let templates = [
        "Atmosphere bed, filtered tonal tail and light noise floor.",
        "Introduce groove clock with hats and ghost percussion only.",
        "Raise tension with bass hints, transient lifts and short riser.",
        "Expose core drums and a clean fill into the original downbeat.",
    ];

    let mut cursor = 1;
    parts
        .iter()
        .enumerate()
        .map(|(index, size)| {
            let start_bar = cursor;
            let end_bar = cursor + size - 1;
            cursor = end_bar + 1;

            let treatment = if request.preserve_vocals && index >= 2 {
                format!(
                    "{} Keep vocal identity muted or sliced to avoid pre-empting the topline.",
                    templates[index]
                )
            } else {
                templates[index].to_string()
            };

            PlanSegment {
                label: format!("Intro Stage {}", index + 1),
                start_bar,
                end_bar,
                energy: energy_lane(&request.energy_profile, index, true),
                treatment,
            }
        })
        .collect()
}

fn build_outro_sections(request: &ExtensionPlannerRequest, outro_bars: u32) -> Vec<PlanSegment> {
    if outro_bars == 0 {
        return Vec::new();
    }

    let parts = split_sections(outro_bars);
    let templates = [
        "Hold groove continuity while trimming lead hooks and busy fills.",
        "Thin harmonic stack, leave rhythm section stable for mixing headroom.",
        "Filter bass movement and prioritise drum clock with sparse tonal residue.",
        "Finish with DJ-safe percussion, echoes and a tail that can loop cleanly.",
    ];

    let mut cursor = 1;
    parts
        .iter()
        .enumerate()
        .map(|(index, size)| {
            let start_bar = cursor;
            let end_bar = cursor + size - 1;
            cursor = end_bar + 1;

            let treatment = if request.preserve_vocals && index == 0 {
                format!(
                    "{} Delay vocal throws instead of removing them abruptly.",
                    templates[index]
                )
            } else {
                templates[index].to_string()
            };

            PlanSegment {
                label: format!("Outro Stage {}", index + 1),
                start_bar,
                end_bar,
                energy: energy_lane(&request.energy_profile, index, false),
                treatment,
            }
        })
        .collect()
}

fn normalized_style(style: &str) -> &str {
    match style {
        "cleaner_club_edit" => "cleaner club edit",
        "modern_deep_house_edit" => "modern deep house edit",
        "radio_to_club_extended" => "radio to club extended",
        _ => "close to original",
    }
}

fn normalized_vocal(vocal: &str) -> &str {
    match vocal {
        "vocal_chops_only" => "vocal chops only",
        "keep_short_hook" => "keep short hook",
        _ => "no vocals in intro/outro",
    }
}

fn build_takes(
    request: &ExtensionPlannerRequest,
    sanitized_title: &str,
    quantized_intro_bars: u32,
    quantized_outro_bars: u32,
    take_count: u32,
) -> Vec<PlanTake> {
    let focuses = [
        "transient-locked drums",
        "groove-first blend",
        "atmospheric extension",
        "bass-forward transition",
        "minimal DJ utility",
    ];

    let safe_count = take_count.clamp(1, 5);
    let style = normalized_style(&request.style_preset);
    let vocal = normalized_vocal(&request.vocal_handling);

    (0..safe_count)
        .map(|index| {
            let focus = focuses[index as usize].to_string();
            let label = format!("Take {} - {}", index + 1, focus);

            let mut render_notes = vec![
                format!("Target style preset: {}", style),
                format!("Vocal handling policy: {}", vocal),
                format!("Keep beatgrid locked at {:.0} BPM", request.bpm),
            ];

            if quantized_intro_bars > 0 {
                render_notes.push(format!(
                    "Render phrase-locked intro with {} bars",
                    quantized_intro_bars
                ));
            }

            if quantized_outro_bars > 0 {
                render_notes.push(format!(
                    "Render phrase-locked outro with {} bars",
                    quantized_outro_bars
                ));
            }

            PlanTake {
                take_index: index + 1,
                label,
                variation_focus: focus,
                render_notes,
                export_label: format!(
                    "{}_TAKE{}_{}BPM_INT{}B_OUT{}B.wav",
                    sanitized_title,
                    index + 1,
                    request.bpm as u32,
                    quantized_intro_bars,
                    quantized_outro_bars
                ),
            }
        })
        .collect()
}

#[tauri::command]
fn build_extension_plan(
    request: ExtensionPlannerRequest,
) -> Result<ExtensionPlannerResponse, String> {
    if !(70.0..=180.0).contains(&request.bpm) {
        return Err("BPM must stay between 70 and 180 for the current planner.".into());
    }

    if request.detected_phrase_bars == 0 {
        return Err("Phrase size must be greater than zero.".into());
    }

    if request.duration_seconds < 60.0 {
        return Err("Track duration must be at least 60 seconds.".into());
    }

    if let Some(false) = request.analysis_production_ready {
        return Err("Professional analysis gates are not passing. Planner is locked.".into());
    }

    if let Some(false) = request.stem_package_ready {
        return Err("Stem package quality gate failed. Planner is locked until stems are ready.".into());
    }

    if request.stem_package_ready != Some(true) {
        return Err("Stem package is required for professional planning mode.".into());
    }

    let estimated_total_bars = ((request.duration_seconds / bars_to_seconds(request.bpm, 1)).round()
        as u32)
        .max(request.detected_phrase_bars * 4);

    let requested_intro = if request.operation_mode == "outro" {
        0
    } else {
        request.intro_bars
    };
    let requested_outro = if request.operation_mode == "intro" {
        0
    } else {
        request.outro_bars
    };

    let quantized_intro_bars =
        quantize_bars_to_phrase(requested_intro, request.detected_phrase_bars);
    let quantized_outro_bars =
        quantize_bars_to_phrase(requested_outro, request.detected_phrase_bars);

    let intro_duration_seconds = rounded_duration(bars_to_seconds(request.bpm, quantized_intro_bars));
    let outro_duration_seconds = rounded_duration(bars_to_seconds(request.bpm, quantized_outro_bars));
    let total_export_duration_seconds = rounded_duration(
        request.duration_seconds + intro_duration_seconds + outro_duration_seconds,
    );

    let phrase = request.detected_phrase_bars.max(1);
    let recommended_source_entry_bar = phrase;
    let source_outro_start_bar = estimated_total_bars.saturating_sub(quantized_outro_bars).max(1);
    let recommended_outro_start_bar = ((source_outro_start_bar + phrase - 1) / phrase) * phrase;

    let base_quality = request.analysis_overall_score.unwrap_or(0.55);
    let marker_component = request
        .marker_count
        .map(|count| clamp(count as f64 / 500.0, 0.0, 1.0))
        .unwrap_or(0.45);
    let downbeat_component = request.downbeat_confidence.unwrap_or(0.5);
    let downbeat_offset_penalty = request
        .downbeat_offset_seconds
        .map(|offset| clamp(offset / bars_to_seconds(request.bpm, 1), 0.0, 1.0) * 0.1)
        .unwrap_or(0.0);
    let planner_quality_score = clamp(
        (base_quality * 0.55) + (marker_component * 0.25) + (downbeat_component * 0.20)
            - downbeat_offset_penalty,
        0.0,
        1.0,
    );

    let mut warnings = Vec::new();
    if request.intro_bars % request.detected_phrase_bars != 0
        || request.outro_bars % request.detected_phrase_bars != 0
    {
        warnings.push(
            "Requested intro/outro bars do not perfectly align with phrase size; planner quantized them."
                .to_string(),
        );
    }

    if estimated_total_bars < request.detected_phrase_bars * 12 {
        warnings.push(
            "Source track looks short for long extensions; stem repetition control will matter."
                .to_string(),
        );
    }

    if request.preserve_vocals {
        warnings.push(
            "Vocal preservation reduces how aggressively the planner can strip transition content."
                .to_string(),
        );
    }

    if request.take_count > 5 {
        warnings.push("Take count above 5 is clamped for deterministic quality control.".to_string());
    }

    if planner_quality_score < 0.78 {
        warnings.push(
            "Planner quality score is below pro threshold (78%). Verify markers and analysis confidence."
                .to_string(),
        );
    }

    let engineer_notes = vec![
        format!(
            "Anchor original song entry on a {}-bar phrase boundary.",
            request.detected_phrase_bars
        ),
        format!(
            "Match generated material to {} at {:.0} BPM before limiting.",
            request.musical_key, request.bpm
        ),
        format!(
            "Bias tonal choices toward {} and keep drum transients club-forward.",
            request.genre
        ),
        format!(
            "Apply style preset '{}' with vocal policy '{}'.",
            normalized_style(&request.style_preset),
            normalized_vocal(&request.vocal_handling)
        ),
        format!(
            "Use stem engine '{}' with package id '{}'.",
            request
                .stem_engine
                .clone()
                .unwrap_or_else(|| "unknown-stem-engine".to_string()),
            request
                .stem_package_id
                .clone()
                .unwrap_or_else(|| "unknown-package".to_string())
        ),
        "Export one clean master and one drums-first variant for safer DJ handoff.".to_string(),
    ];

    let sanitized_title = request
        .title
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '_' })
        .collect::<String>();

    let takes = build_takes(
        &request,
        &sanitized_title,
        quantized_intro_bars,
        quantized_outro_bars,
        request.take_count,
    );

    Ok(ExtensionPlannerResponse {
        project_title: format!("{} Extension Plan", request.title),
        source_title: request.title.clone(),
        estimated_total_bars,
        intro_bars: requested_intro,
        outro_bars: requested_outro,
        quantized_intro_bars,
        quantized_outro_bars,
        recommended_source_entry_bar,
        recommended_outro_start_bar,
        planner_quality_score,
        intro_duration_seconds,
        outro_duration_seconds,
        total_export_duration_seconds,
        intro_sections: build_intro_sections(&request, quantized_intro_bars),
        outro_sections: build_outro_sections(&request, quantized_outro_bars),
        takes,
        warnings,
        engineer_notes,
        export_label: format!(
            "{}_{}BPM_INT{}B_OUT{}B.wav",
            sanitized_title, request.bpm as u32, request.intro_bars, request.outro_bars
        ),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![build_extension_plan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

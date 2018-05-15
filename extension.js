const vscode = require('vscode');
const url = require('url');
const http = require('http');
const fs = require('fs');
const child_process = require('child_process');

var rainbow_utils = require('./rainbow_utils');

var dialect_map = {'csv': [',', 'quoted'], 'tsv': ['\t', 'simple'], 'csv (semicolon)': [';', 'quoted']};

var oc_log = null;

var lint_results = new Map();
var sb_item = null;

var rbql_context = null;

var http_server = null;

var last_rbql_queries = new Map();

var client_js_template_path = null;
var client_html_template_path = null;
var mock_script_path = null;

var enable_dev_mode = true; // FIXME init this entry from config

var client_js_template = null;
var client_html_template = null;

var security_tokens = null;
var used_tokens = null;

function dbg_log(msg) {
    if (!enable_dev_mode)
        return;
    if (!oc_log) {
        oc_log = vscode.window.createOutputChannel("rainbow_csv_oc");
        oc_log.show();
    }
    oc_log.appendLine(msg);
}


function sample_preview_records(document, window_center, window_size, delim, policy) {
    var adjusted_window = rainbow_utils.adjust_window_borders(window_center, window_size, document.lineCount);
    var line_begin = adjusted_window[0];
    var line_end = adjusted_window[1];
    var preview_records = [];
    var max_cols = 0;
    for (var nr = line_begin; nr < line_end; nr++) {
        var line_text = document.lineAt(nr).text;
        var cur_record = rainbow_utils.smart_split(line_text, delim, policy, false)[0];
        max_cols = Math.max(max_cols, cur_record.length);
        cur_record.splice(0, 0, nr + 1);
        preview_records.push(cur_record);
    }
    var header_record = ['NR'];
    for (var i = 0; i < max_cols; i++) {
        header_record.push('a' + (i + 1));
    }
    preview_records.splice(0, 0, header_record);
    return preview_records;
}


function guess_document_header(document, delim, policy) {
    var sampled_records = [];
    var num_lines = document.lineCount;
    var head_count = 10;
    if (num_lines <= head_count * 2) {
        for (var i = 1; i < num_lines; i++) {
            sampled_records.push(rainbow_utils.smart_split(document.lineAt(i).text, delim, policy, false)[0]);
        }
    } else {
        for (var i = 1; i < head_count; i++) {
            sampled_records.push(rainbow_utils.smart_split(document.lineAt(i).text, delim, policy, false)[0]);
        }
        for (var i = num_lines - head_count; i < num_lines; i++) {
            sampled_records.push(rainbow_utils.smart_split(document.lineAt(i).text, delim, policy, false)[0]);
        }
    }
    while (sampled_records.length) {
        var last = sampled_records[sampled_records.length - 1];
        if (last.length != 1 || last[0] != "")
            break;
        sampled_records.pop();
    }
    if (sampled_records.length < 10)
        return null;
    var potential_header = rainbow_utils.smart_split(document.lineAt(0).text, delim, policy, false)[0];
    var has_header = rainbow_utils.guess_if_header(potential_header, sampled_records);
    return has_header ? potential_header : null;
}


function make_hover_text(document, position, language_id) {
    var delim = dialect_map[language_id][0];
    var policy = dialect_map[language_id][1];
    var lnum = position.line;
    var cnum = position.character;
    var line = document.lineAt(lnum).text;

    var report = rainbow_utils.smart_split(line, delim, policy, false);

    var entries = report[0];
    var warning = report[1];
    var col_num = rainbow_utils.get_field_by_line_position(entries, cnum + 1);

    if (col_num == null)
        return null;
    var result = 'col# ' + (col_num + 1);
    if (warning)
        return result + '; This line has quoting error!';
    var header = guess_document_header(document, delim, policy);
    if (header !== null && header.length == entries.length) {
        var column_name = header[col_num];
        result += ', "' + column_name + '"';
    }
    return result;
}


function make_hover(document, position, language_id, cancellation_token) {
    setTimeout(function() { 
        if (csv_lint(true, document)) {
            show_linter_state();
        }
    });
    var hover_text = make_hover_text(document, position, language_id);
    if (hover_text && !cancellation_token.isCancellationRequested) {
        return new vscode.Hover(hover_text);
    } else {
        return null;
    }
}


function produce_lint_report(active_doc, delim, policy, max_check_size) {
    var num_lines = active_doc.lineCount;
    var num_fields = null;
    for (var lnum = 0; lnum < num_lines; lnum++) {
        var line_text = active_doc.lineAt(lnum).text;
        if (lnum + 1 == num_lines && !line_text)
            break;
        var split_result = rainbow_utils.smart_split(line_text, delim, policy, false);
        if (split_result[1]) {
            return 'Error. Line ' + (lnum + 1) + ' has formatting error: double quote chars are not consistent';
        }
        if (lnum === 0)
            num_fields = split_result[0].length;
        if (num_fields != split_result[0].length) {
            return 'Error. Number of fields is not consistent: e.g. line 1 has ' + num_fields + ' fields, and line ' + (lnum + 1) + ' has ' + split_result[0].length + ' fields.';
        }
        if (max_check_size && lnum > max_check_size) {
            return 'File is too big: autocheck was cancelled';
        }
    }
    return 'OK';
}


function get_active_doc() {
    var active_window = vscode.window;
    if (!active_window)
        return null;
    var active_editor = active_window.activeTextEditor;
    if (!active_editor)
        return null;
    var active_doc = active_editor.document;
    if (!active_doc)
        return null;
    return active_doc;
}


function csv_lint_cmd() {
    csv_lint(false, null);
    // Need timeout here to give user enough time to notice green -> yellow -> green switch, this is a sort of visual feedback
    setTimeout(show_linter_state, 500);
}


function handle_preview_success(success) {
    dbg_log('preview success!');
}


function handle_preview_error(reason) {
    dbg_log('preview failure!');
    dbg_log(reason);
    vscode.window.showErrorMessage('Unable to create query window.\nReason: ' + reason);
}


function show_warnings(warnings) {
    // VSCode warnings are single-line, so this works only because all current RBQL warnings are also single-line.
    if (!warnings || !warnings.length)
        return;
    var active_window = vscode.window;
    if (!active_window)
        return null;
    active_window.showWarningMessage('RBQL query has been completed with warnings!');
    for (var i = 0; i < warnings.length; i++) {
        active_window.showWarningMessage(warnings[i]);
    }
}

function show_single_line_error(error_msg) {
    var active_window = vscode.window;
    if (!active_window)
        return;
    active_window.showErrorMessage(error_msg);
}


function handle_rbql_result_file(text_doc, warnings) {
    var active_window = vscode.window;
    if (!active_window)
        return;
    var handle_success = function(editor) { show_warnings(warnings); };
    var handle_failure = function(reason) { show_single_line_error('Unable to show open document'); };
    active_window.showTextDocument(text_doc).then(handle_success, handle_failure);
}



function run_command(cmd, args, callback_func) {
    var command = child_process.spawn(cmd, args);
    var stdout = '';
    var stderr = '';
    command.stdout.on('data', function(data) {
         stdout += data.toString();
    });
    command.stderr.on('data', function(data) {
         stderr += data.toString();
    });
    command.on('close', function(code) {
        return callback_func(code, stdout, stderr);
    });
}


function handle_request(request, response) {
    var parsed_url = url.parse(request.url, true);
    dbg_log('request.url: ' + request.url);
    var pathname = parsed_url.pathname;
    var active_file_path = rbql_context['document'].fileName;
    if (pathname == '/init') {
        response.writeHead(200, {'Content-Type': 'application/json'});
        var init_msg = {"host_language": get_rbql_host_language()};
        var window_records = sample_preview_records(rbql_context.document, rbql_context.line, 12, rbql_context.delim, rbql_context.policy);
        init_msg['window_records'] = window_records;

        var customized_colors = get_customized_colors();
        if (enable_dev_mode && Math.random() > 0.5) {
            customized_colors = null; // Improves code coverage in dev mode
        }
        if (customized_colors) {
            init_msg['custom_colors'] = customized_colors;
        }

        var last_rbql_query = last_rbql_queries[active_file_path];
        if (last_rbql_query) {
            init_msg['last_query'] = last_rbql_query;
        }
        response.end(JSON.stringify(init_msg));
        return;
    } else if (pathname == '/run') {
        var query = parsed_url.query;
        var rbql_query = query.rbql_query;
        var host_language = query.host_language;
        var security_token = query.security_token;
        dbg_log('security_token: ' + security_token);
        if (security_tokens.indexOf(security_token) == -1 || used_tokens.indexOf(security_token) != -1)
            return;
        used_tokens.push(security_token);
        last_rbql_queries[active_file_path] = rbql_query;
        dbg_log('rbql_query: ' + rbql_query);
        var cmd = null;
        var args = null;
        const test_marker = 'test ';
        if (rbql_query.startsWith(test_marker)) {
            rbql_query = rbql_query.substr(test_marker.length);
            dbg_log('mock script path: ' + mock_script_path);
            cmd = 'python';
            args = [mock_script_path, rbql_query];
        }
        run_command(cmd, args, function(error_code, stdout, stderr) {
            dbg_log('error_code: ' + String(error_code));
            dbg_log('stdout: ' + String(stdout));
            dbg_log('stderr: ' + String(stderr));

            var report = null;
            var json_report = stdout;
            if (error_code || !json_report.length || stderr.length) {
                var error_details = "Unknown Integration Error";
                if (stderr.length) {
                    error_details += '\nstderr: ' + stderr;
                }
                report = {"error_type": "Integration", "error_details": error_details};
            } else {
                try {
                    report = JSON.parse(json_report);
                } catch (e) {
                    report = {"error_type": "Integration", "error_details": "Report JSON parsing error"};
                }
            }
            response.writeHead(200, {'Content-Type': 'application/json'});
            response.end(JSON.stringify(report));
            if (report.hasOwnProperty('error_type') || report.hasOwnProperty('error_details')) {
                return; // Just exit: error would be shown in the preview window.
            }
            var warnings = [];
            if (report.hasOwnProperty('warnings')) {
                warnings = report['warnings'];
            }
            if (!report.hasOwnProperty('result_path')) {
                show_single_line_error('Something went terribly wrong: RBQL JSON report is missing result_path attribute');
                return;
            }
            var dst_table_path = report['result_path'];
            dbg_log('dst_table_path: ' + dst_table_path);

            var handle_success = function(new_doc) { handle_rbql_result_file(new_doc, warnings); };
            var handle_failure = function(reason) { show_single_line_error('Unable to open result set file at ' + dst_table_path); };
            vscode.workspace.openTextDocument(dst_table_path).then(handle_success, handle_failure);
        });
        return;
    }
}


function edit_rbql() {
    // TODO show error instead of silent exit
    var active_window = vscode.window;
    if (!active_window)
        return null;
    var active_editor = active_window.activeTextEditor;
    if (!active_editor)
        return null;
    var active_doc = active_editor.document;
    if (!active_doc)
        return null;
    var orig_uri = active_doc.uri;
    if (!orig_uri || orig_uri.scheme != 'file')
        return;
    var language_id = active_doc.languageId;
    if (!dialect_map.hasOwnProperty(language_id))
        return; // FIXME allow this. Non-csv language_id means monocolumn mode.
    var delim = dialect_map[language_id][0];
    var policy = dialect_map[language_id][1];
    var cursor_line = active_editor.selection.isEmpty ? active_editor.selection.active.line : 0;
    if (http_server) {
        http_server.close();
    }
    http_server = http.createServer(handle_request);

    var port = http_server.listen(0).address().port; // 0 means listen on a random port
    rbql_context = {"document": active_doc, "line": cursor_line, "server_port": port, "delim": delim, "policy": policy};
    var rbql_uri = vscode.Uri.parse('rbql://authority/rbql');
    vscode.commands.executeCommand('vscode.previewHtml', rbql_uri, undefined, 'RBQL Dashboard').then(handle_preview_success, handle_preview_error);
}

function get_rbql_host_language() {
    var supported_hosts = ['python', 'js'];
    var default_host = 'python';
    const config = vscode.workspace.getConfiguration('rainbow_csv');
    if (config && config.get('rbql_host_language')) {
        var host_language = config.get('rbql_host_language').toLowerCase();
        if (supported_hosts.indexOf(host_language) != -1) {
            return host_language;
        }
    }
    return default_host;
}

function csv_lint(autolint, active_doc) {
    if (autolint) {
        const config = vscode.workspace.getConfiguration('rainbow_csv');
        if (config && config.get('enable_auto_csv_lint') === false)
            return false;
    }
    if (!active_doc)
        active_doc = get_active_doc();
    if (!active_doc)
        return false;
    var file_path = active_doc.fileName;
    if (!file_path)
        return false;
    var language_id = active_doc.languageId;
    if (!dialect_map.hasOwnProperty(language_id))
        return false;
    if (autolint && lint_results.has(file_path))
        return false;
    lint_results.set(file_path, 'Processing...');
    show_linter_state(); // Visual feedback
    var delim = dialect_map[language_id][0];
    var policy = dialect_map[language_id][1];
    var max_check_size = autolint ? 50000 : null;
    var lint_report = produce_lint_report(active_doc, delim, policy, max_check_size);
    lint_results.set(file_path, lint_report);
    return true;
}


function show_linter_state() {
    if (sb_item)
        sb_item.hide();
    var active_doc = get_active_doc();
    if (!active_doc)
        return;
    var language_id = active_doc.languageId;
    if (!dialect_map.hasOwnProperty(language_id))
        return;
    var file_path = active_doc.fileName;
    if (!lint_results.has(file_path))
        return;
    var lint_report = lint_results.get(file_path);
    if (!sb_item)
        sb_item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    sb_item.text = 'CSVLint';
    if (lint_report === 'OK') {
        sb_item.color = '#62f442';
    } else if (lint_report.indexOf('File is too big') != -1 || lint_report == 'Processing...') {
        sb_item.color = '#ffff28';
    } else {
        sb_item.color = '#f44242';
    }
    sb_item.tooltip = lint_report + '\nClick to recheck';
    sb_item.command = 'extension.CSVLint';
    sb_item.show();
}


function handle_editor_change(editor) {
    csv_lint(true, null);
    show_linter_state();
}



function assert(condition, message) {
    if (!condition) {
        throw message || "Assertion failed";
    }
}


function get_customized_colors() {
    var rainbow_rules = ['rainbow1', 'keyword.rainbow2', 'entity.name.function.rainbow3', 'comment.rainbow4', 'string.rainbow5', 'variable.parameter.rainbow6', 'constant.numeric.rainbow7', 'entity.name.type.rainbow8', 'markup.bold.rainbow9', 'invalid.rainbow10']
    var color_config = vscode.workspace.getConfiguration('editor.tokenColorCustomizations');
    if (!color_config) {
        dbg_log('config not found');
        return null;
    }
    var text_mate_rules = color_config['textMateRules'];
    if (!text_mate_rules) {
        dbg_log('no text mate rules');
        return null;
    }
    var result = [null, null, null, null, null, null, null, null, null, null];
    assert(rainbow_rules.length == result.length, 'fail');
    for (var i = 0; i < text_mate_rules.length; i++) {
        var rule = text_mate_rules[i];
        if (!rule) {
            continue;
        }
        var scope = rule['scope'];
        var idx = rainbow_rules.indexOf(scope);
        if (idx == -1) {
            continue;
        }
        var settings = rule['settings'];
        if (!settings) {
            dbg_log('no settings found for scope ' + scope);
            continue;
        }
        if (!settings.hasOwnProperty('fontStyle')) {
            if (scope == 'markup.bold.rainbow9') {
                settings['fontStyle'] = 'bold';
            } else {
                settings['fontStyle'] = '';
            }
        }
        result[idx] = settings;
    }
    for (var i = 0; i < result.length; i++) {
        if (!result[i] || !result[i].hasOwnProperty('foreground')) {
            dbg_log('result entry ' + i + ' is empty');
            return null;
        }
    }
    return result;
}


function slow_replace_all(src, old_substr, new_substr) {
    while (src.indexOf(old_substr) != -1) {
        src = src.replace(old_substr, new_substr);
    }
    return src;
}


function make_preview(client_html_template, client_js_template, origin_server_port) {
    // This function gets called every time user activates RBQL preview tab and in original preview request.
    security_tokens = [];
    used_tokens = [];
    for (var i = 0; i < 100; i++) {
        security_tokens.push(String(Math.random()));
    }
    if (client_js_template.indexOf('</script') != -1) {
        return null;
    }
    client_html_template = slow_replace_all(client_html_template, '//__TEMPLATE_JS_CLIENT__', client_js_template);
    client_html_template = slow_replace_all(client_html_template, '__TEMPLATE_JS_PORT__', String(origin_server_port));
    client_html_template = slow_replace_all(client_html_template, '"__TEMPLATE_SECURITY_TOKENS__"', security_tokens.join(','));
    return client_html_template;
}


class RBQLProvider {
    constructor(context) {
        this.onDidChangeEvent = new vscode.EventEmitter();
    }

    provideTextDocumentContent(uri, token) {
        if (!client_js_template || enable_dev_mode) {
            client_js_template = fs.readFileSync(client_js_template_path, "utf8");
        }
        if (!client_html_template || enable_dev_mode) {
            client_html_template = fs.readFileSync(client_html_template_path, "utf8");
        }
        return make_preview(client_html_template, client_js_template, rbql_context.server_port);
    }

    get onDidChange() {
        return this.onDidChangeEvent.event;
    }

    update(uri) {
        this.onDidChangeEvent.fire(uri);
    }
}

function activate(context) {

    dbg_log('Activating "rainbow_csv"');

    var rbql_provider = new RBQLProvider(context);

    client_js_template_path = context.asAbsolutePath('rbql_client.js');
    client_html_template_path = context.asAbsolutePath('rbql_client.html');
    mock_script_path = context.asAbsolutePath('rbql mock/rbql_mock.py');

    var csv_provider = vscode.languages.registerHoverProvider('csv', {
        provideHover(document, position, token) {
            return make_hover(document, position, 'csv', token);
        }
    });

    var tsv_provider = vscode.languages.registerHoverProvider('tsv', {
        provideHover(document, position, token) {
            return make_hover(document, position, 'tsv', token);
        }
    });

    var scsv_provider = vscode.languages.registerHoverProvider('csv (semicolon)', {
        provideHover(document, position, token) {
            return make_hover(document, position, 'csv (semicolon)', token);
        }
    });

    var lint_cmd = vscode.commands.registerCommand('extension.CSVLint', csv_lint_cmd);
    var rbql_cmd = vscode.commands.registerCommand('extension.RBQL', edit_rbql);

    var switch_event = vscode.window.onDidChangeActiveTextEditor(handle_editor_change)

    var preview_subscription = vscode.workspace.registerTextDocumentContentProvider('rbql', rbql_provider);

    context.subscriptions.push(csv_provider);
    context.subscriptions.push(tsv_provider);
    context.subscriptions.push(scsv_provider);
    context.subscriptions.push(lint_cmd);
    context.subscriptions.push(rbql_cmd);
    context.subscriptions.push(switch_event);
    context.subscriptions.push(preview_subscription);
}


exports.activate = activate;

function deactivate() {
    // This method is called when extension is deactivated
}

exports.deactivate = deactivate;

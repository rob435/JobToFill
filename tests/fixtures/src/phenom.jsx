// A Phenom application form (careers.marsh.com/…/apply, a Workday job behind it), its "My information", "My
// experience" and "Additional application questions" steps on one page, built as Phenom builds them:
// react-jsonschema-form rows (`<label for>` beside each box), Workday's degree and field-of-study lists, and the work
// dates as react-datepicker month pickers set up the way Phenom sets them up. Those take no typing: the box blurs
// itself on focus and drops whatever is typed (onChangeRaw → preventDefault), so a date only goes in through the
// calendar (a year <select> in the header, then a month). "To" can't be before "From"; with ?gap=31 it can't be the
// same month either (Phenom's durationDifference, in days). Its uploads say what they are for only in the text
// before them: "An optional cover letter (or any other documents…)", "Please upload a copy of your cover letter.",
// "Please upload any other relevant documents." The form's state is printed into #state on every change.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DatePicker from 'react-datepicker';
import css from 'react-datepicker/dist/react-datepicker.css';
import { DEGREES, FIELDS, SOURCES } from './phenom-data.mjs';

const params = new URLSearchParams(location.search);
const GAP = +params.get('gap') || 0;
const today = new Date();
const THIS_MONTH = new Date(today.getFullYear(), today.getMonth(), 1);

const pad = (n) => String(n).padStart(2, '0');
const monthYear = (d) => (d ? `${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '');
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Phenom's calendar header: "<", a year <select> from minDate to maxDate, ">". */
function header({ date, changeYear, decreaseMonth, increaseMonth, minDate, maxDate }) {
  const years = [];
  for (let y = minDate.getFullYear(); y <= maxDate.getFullYear(); y++) years.push(y);
  return (
    <div className="range-div">
      <button aria-label="Previous Month" onClick={(e) => (e.preventDefault(), decreaseMonth())}>
        {'<'}
      </button>
      <select className="range-select" value={date.getFullYear()} onChange={(e) => changeYear(+e.target.value)}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button aria-label="Next Month" onClick={(e) => (e.preventDefault(), increaseMonth())}>
        {'>'}
      </button>
    </div>
  );
}

function Row({ id, label, required, children }) {
  return (
    <div className="row form-group field field-string foo">
      <label className="col-12 col-sm-12 col-md-5 control-label" htmlFor={id} id={`${id}-label`}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className="col-12 col-sm-12 col-md-7">{children}</div>
    </div>
  );
}

function Text({ id, label, required, value, onChange, textarea }) {
  return (
    <Row id={id} label={label} required={required}>
      {textarea ? (
        <textarea id={id} className="form-control" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          aria-label={label}
          className="form-control"
          required={required}
          autoComplete="off"
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Row>
  );
}

function Select({ id, label, rows, value, onChange }) {
  return (
    <Row id={id} label={label} required>
      <select
        id={id}
        className="form-control"
        required
        aria-labelledby={`${id}-label`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Please Select</option>
        {rows.map(([text, v]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** One of Phenom's month boxes: typing is thrown away, the calendar is the only way in. */
function MonthBox({ id, label, selected, onChange, minDate, maxDate, start, end }) {
  const live = `${id}-live-region`;
  return (
    <div className="form-group field field-string foo row date-range-picker">
      <label className="col-xs-12 col-sm-12 col-md-5 col-lg-5" htmlFor={id} id={`${id}-label`} aria-label={label}>
        {label}
        <span aria-hidden="true" className="required">
          *
        </span>
      </label>
      <div className="col-xs-12 col-sm-12 col-md-7 col-lg-7" tabIndex="-1">
        <DatePicker
          className="form-control"
          id={id}
          selected={selected}
          onChange={onChange}
          onChangeRaw={(e) => e && e.preventDefault()}
          selectsStart={start}
          selectsEnd={end}
          isClearable
          minDate={minDate}
          maxDate={maxDate}
          dateFormat="MM/yyyy"
          showMonthYearPicker
          showDisabledMonthNavigation
          ariaLabelledBy={live}
          ariaDescribedBy={live}
          onFocus={(e) => e.target.blur()}
          renderCustomHeader={(p) => header({ ...p, minDate: minDate || new Date(1900, 0, 1), maxDate })}
        />
      </div>
    </div>
  );
}

function Experience({ i, job, set, remove }) {
  const id = (k) => `experienceData[${i}].${k}`;
  const min = job.start ? addDays(job.start, GAP) : undefined;
  return (
    <div className="row array-item-list no-gutters array-item educationhide">
      <div className="col-xs-11 col-11">
        <div className="form-group field field-object">
          <fieldset id={`experienceData[${i}]`}>
            <Text id={id('title')} label="Job title" required value={job.title} onChange={(v) => set({ title: v })} />
            <Text
              id={id('companyName')}
              label="Company"
              required
              value={job.company}
              onChange={(v) => set({ company: v })}
            />
            <Text id={id('location')} label="Location" value={job.location} onChange={(v) => set({ location: v })} />
            <div className="form-group field field-object">
              <div id={`experienceData_${i}_fromTo`} className="date-range-fromTo">
                {['startDate', 'endDate', 'currentlyWorkHere'].map((k) => (
                  <div key={k} className="sr-only" aria-live="polite" id={`${id('fromTo.' + k)}-live-region`} />
                ))}
                <MonthBox
                  id={id('fromTo.startDate')}
                  label="From"
                  selected={job.start}
                  onChange={(d) => set({ start: d })}
                  maxDate={job.end || THIS_MONTH}
                  start
                />
                <MonthBox
                  id={id('fromTo.endDate')}
                  label="To"
                  selected={job.end}
                  onChange={(d) => set({ end: d })}
                  minDate={min}
                  maxDate={THIS_MONTH}
                  end
                />
              </div>
              <div id="I currently work here" className="daterangepicker-checkbox">
                <input
                  type="checkbox"
                  id={id('fromTo.currentlyWorkHere')}
                  aria-label="I currently work here"
                  checked={job.current}
                  onChange={(e) => set({ current: e.target.checked })}
                />
                <span className="checkboxText">I currently work here</span>
              </div>
            </div>
            <Text
              id={id('description')}
              label="Role description"
              textarea
              value={job.description}
              onChange={(v) => set({ description: v })}
            />
          </fieldset>
        </div>
      </div>
      <div className="col-xs-1 col-1 remove-action">
        <button
          type="button"
          className="array-button-remove"
          id={`work-experience-array-button-remove-${i}`}
          aria-label="Remove experience"
          onClick={remove}
        >
          <div>
            <span className="remove-icon">-</span>
          </div>
        </button>
      </div>
    </div>
  );
}

function Education({ i, school, set }) {
  const id = (k) => `educationData[${i}].${k}`;
  return (
    <div className="row array-item-list no-gutters array-item educationhide">
      <div className="col-xs-11 col-11">
        <div className="form-group field field-object">
          <fieldset id={`educationData[${i}]`}>
            <Text
              id={id('schoolName')}
              label="School or University"
              required
              value={school.name}
              onChange={(v) => set({ name: v })}
            />
            <Select
              id={id('degree')}
              label="Degree"
              rows={DEGREES}
              value={school.degree}
              onChange={(v) => set({ degree: v })}
            />
            <Select
              id={id('fieldOfStudy')}
              label="Field of study"
              rows={FIELDS}
              value={school.field}
              onChange={(v) => set({ field: v })}
            />
          </fieldset>
        </div>
      </div>
      <div className="col-xs-1 col-1 remove-action" />
    </div>
  );
}

const LANGUAGES = [
  'Danish',
  'Dutch',
  'English',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Italian',
  'Norwegian',
  'Portuguese',
  'Spanish',
  'Swedish',
  'Arabic',
  'Cantonese',
  'Mandarin',
  'Russian',
  'Other',
];
const CODING = ['C / C++ / C#', 'Java', 'MATLAB', 'Python', 'R', 'SAS', 'SQL', 'Other'];
const JSQ = 'secondaryJsqData.QUESTIONNAIRE-3-2288';

/** Phenom's v2 upload in a questionnaire: its question is a bare label beside the widget's column. */
function Attachment({ id, label, required, files, onFiles }) {
  return (
    <div className="col-md-12">
      <div className="form-group field field-object">
        <div className="row form-group additional-attachment-v2">
          <label className="control-label col-md-6">
            {label}
            {required && <span className="required">*</span>}
          </label>
          <div className="col-md-6">
            <div className="attachment-wrapper" id={id}>
              <div className="attachment">
                <div className="attachment-title">Upload either DOC, DOCX, HTML, PDF, or TXT file types (1MB max)</div>
                <div className="attachment-container">
                  <ul className="attachment-options">
                    <li>
                      <div tabIndex="0" className="dropbox" title="Dropbox" role="button" />
                    </li>
                    <li>
                      <div tabIndex="0" className="skydrive" title="Onedrive" role="button" />
                    </li>
                    <li>
                      <div className="or">or</div>
                    </li>
                    <li className="file-attachment">
                      <div>
                        <label className="file-label" role="presentation" tabIndex="0">
                          <span className="title-text">Select file</span>
                          <input
                            type="file"
                            style={{ display: 'none' }}
                            onChange={(e) => onFiles([...files, ...[...e.target.files].map((f) => f.name)])}
                          />
                        </label>
                      </div>
                    </li>
                  </ul>
                </div>
              </div>
              {files.map((f) => (
                <p key={f} className="file-name">
                  {f}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A question of the questionnaire: `<label for>` beside a box, a list or a group of ticks. */
function Question({ k, label, required, children }) {
  const id = `${JSQ}.${k}`;
  return (
    <div className="col-md-12">
      <div className="row form-group field field-string">
        <label className="col-12 col-sm-12 col-md-5 control-label" htmlFor={id} id={`${id}-label`}>
          {label}
          {required && (
            <span className="required" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <div className="col-12 col-sm-12 col-md-7">{children(id)}</div>
      </div>
    </div>
  );
}

function Ticks({ id, options, picked, onChange }) {
  return (
    <div className="checkboxes" id={id}>
      {options.map((o, i) => (
        <div key={o} className="checkbox ">
          <label>
            <span>
              <input
                aria-describedby={o}
                aria-label={o}
                type="checkbox"
                id={`${id}_${i}`}
                className="checkbox-control"
                checked={picked.includes(o)}
                onChange={(e) => onChange(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))}
              />
              <span className="checkmark" />
              <span>{o}</span>
            </span>
          </label>
        </div>
      ))}
    </div>
  );
}

/** "Additional application questions" (step 4): Marsh's questionnaire, its uploads first. */
function Questionnaire({ answers, set }) {
  const text = (k) => (id) => (
    <textarea
      id={id}
      className="form-control"
      value={answers[k] || ''}
      onChange={(e) => set({ [k]: e.target.value })}
    />
  );
  const date = (k) => (id) => (
    <input
      className="form-control"
      type="date"
      placeholder="yyyy-mm-dd"
      autoComplete="off"
      id={id}
      value={answers[k] || ''}
      onChange={(e) => set({ [k]: e.target.value })}
    />
  );
  const yesNo = (k) => (id) => (
    <select id={id} className="form-control" value={answers[k] || ''} onChange={(e) => set({ [k]: e.target.value })}>
      <option value="">Please Select</option>
      <option value="Yes">Yes</option>
      <option value="No">No</option>
    </select>
  );
  return (
    <fieldset id={JSQ}>
      <legend role="heading">QUESTIONNAIRE-3-2288</legend>
      <div className="row no-gutter form-fields">
        <Attachment
          id={`${JSQ}.a`}
          label="Please upload a copy of your cover letter."
          required
          files={answers.letter || []}
          onFiles={(f) => set({ letter: f })}
        />
        <Attachment
          id={`${JSQ}.b`}
          label="Please upload any other relevant documents."
          files={answers.other || []}
          onFiles={(f) => set({ other: f })}
        />
        <Question
          k="c"
          required
          label="What year will you / did you graduate from your most recent study? Please use the following format: MM/YYYY (e.g. 09/2025)"
        >
          {date('graduation')}
        </Question>
        <Question k="d" required label="Are you in your penultimate year of study?">
          {yesNo('penultimate')}
        </Question>
        <Question
          k="e"
          required
          label="What is your cumulative undergraduate (Bachelor) GPA on the scale used by your local school/university?"
        >
          {text('bachelorGpa')}
        </Question>
        <Question
          k="f"
          required
          label="What is your cumulative graduate (Master) GPA on the scale used by your local school/university?  Please indicate N/A if you do not have a graduate GPA."
        >
          {text('masterGpa')}
        </Question>
        <Question k="g" required label="Please list any languages in which you have native or business level fluency.">
          {(id) => (
            <Ticks
              id={id}
              options={LANGUAGES}
              picked={answers.languages || []}
              onChange={(v) => set({ languages: v })}
            />
          )}
        </Question>
        <Question
          k="h"
          label="If you selected 'Other' in the previous question, please list other languages in which you have native or business level fluency."
        >
          {text('otherLanguages')}
        </Question>
        <Question k="i" required label="Please select any coding languages that you have experience using.">
          {(id) => (
            <Ticks id={id} options={CODING} picked={answers.coding || []} onChange={(v) => set({ coding: v })} />
          )}
        </Question>
        <Question
          k="k"
          required
          label="What date are you available to start work? Please use the following format: MM/YYYY (e.g. 01/2026)."
        >
          {date('start')}
        </Question>
        <Question
          k="l"
          required
          label="Do you require any special requirements if you are invited to attend an interview?"
        >
          {text('adjustments')}
        </Question>
      </div>
    </fieldset>
  );
}

const newJob = () => ({
  title: '',
  company: '',
  location: '',
  start: null,
  end: null,
  current: false,
  description: '',
});
const newSchool = () => ({ name: '', degree: '', field: '' });

function App() {
  const [source, setSource] = useState('');
  const [resume, setResume] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [jobs, setJobs] = useState([newJob()]);
  const [schools, setSchools] = useState([newSchool(), newSchool()]);
  const [answers, setAnswers] = useState({});
  const editJob = (i) => (patch) => setJobs((all) => all.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  const editSchool = (i) => (patch) => setSchools((all) => all.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  useEffect(() => {
    document.getElementById('state').textContent = JSON.stringify({
      applicantSource: source,
      resume,
      attachments,
      experienceData: jobs.map((j) => ({
        title: j.title,
        companyName: j.company,
        location: j.location,
        fromTo: { startDate: monthYear(j.start), endDate: monthYear(j.end), currentlyWorkHere: j.current },
        description: j.description,
      })),
      educationData: schools.map((s) => ({ schoolName: s.name, degree: s.degree, fieldOfStudy: s.field })),
      questionnaire: answers,
      open: document.querySelectorAll('.react-datepicker-popper').length,
    });
  });

  return (
    <div className="phenom-form-container">
      <div className="pageTitle" id="page-title">
        <div className="job-summary">
          <span>You are applying for -</span>
          <h2 className="job-title" role="heading" aria-level="1">
            <a href="#job">Oliver Wyman - Summer Internship 2027 - London (R_363389)</a>
          </h2>
        </div>
      </div>
      <div className="navigation-summary" role="toolbar" id="breadcrumb-summary">
        <ul className="progressbarlist breadcrumb-list">
          {[
            'My information',
            'My experience',
            'Application questions',
            'Additional application questions',
            'Voluntary disclosures',
            'Review',
          ].map((t) => (
            <li key={t} role="button" className="slide" tabIndex="-1">
              <a tabIndex="-1">
                <span className="number" />
                <span className="title">{t}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="resume-section">
        <div className="cloud-options" role="group" aria-labelledby="cloud-options-sr-text">
          <div className="resume_info">
            <span id="cloud-options-sr-text" className="sr-only">
              Upload options
            </span>
            <div className="resume-header">
              <p>
                <span className="resume-mandatory">*</span>Upload your resume or CV by clicking on ‘Upload resume’
                below. If you need to replace the document you selected to upload, simply click on ‘Upload resume’ and
                select a new document.
              </p>
              <p>Upload either DOC, DOCX, RTF, PDF, or TXT file types (1MB max)</p>
            </div>
          </div>
          <div className="resume-upload-wrapper">
            <input
              type="file"
              id="resume-file"
              autoComplete="off"
              tabIndex="-1"
              style={{ display: 'none' }}
              onChange={(e) => setResume([...e.target.files].map((f) => f.name).join(', '))}
            />
            <button type="button" className="upload-resume-btn btn primary-button">
              Upload resume
            </button>
          </div>
        </div>
        {resume && <span className="uploadedFileName">{resume}</span>}
      </div>
      <form className="rjsf" noValidate onSubmit={(e) => e.preventDefault()}>
        <p id="__description" role="heading" aria-level="2" className="field-description">
          My information
        </p>
        <Select
          id="applicantSource"
          label="How did you hear about us?"
          rows={SOURCES.map((s) => [s, s])}
          value={source}
          onChange={setSource}
        />
        <fieldset className="field field-array field-array-of-object" id="experienceData">
          <legend id="experienceData__title" role="heading">
            Work experience :
          </legend>
          {jobs.map((job, i) => (
            <Experience
              key={i}
              i={i}
              job={job}
              set={editJob(i)}
              remove={() => setJobs((all) => all.filter((_, k) => k !== i))}
            />
          ))}
          <button type="button" className="array-button-add" onClick={() => setJobs((all) => [...all, newJob()])}>
            <span>Add experience</span>
          </button>
        </fieldset>
        <div className="row form-group field field-string education">
          <div className="markdown">
            <p>Education :</p>
          </div>
        </div>
        <div className="row form-group field field-string education help">
          <div className="markdown">
            <p>
              Please enter your highest level of education, whether completed or currently in progress.
              <br />
              If you prefer not to provide this information, please enter "Not Applicable".
            </p>
          </div>
        </div>
        <fieldset className="field field-array field-array-of-object" id="educationData">
          <legend id="educationData__title" role="heading">
            Education :
          </legend>
          {schools.map((s, i) => (
            <Education key={i} i={i} school={s} set={editSchool(i)} />
          ))}
        </fieldset>
        <div className="row form-group field field-string markdown-as-header custom-object addln-attach-header">
          <div className="col">
            <div className="markdown">
              <p>Additional attachments :</p>
            </div>
          </div>
        </div>
        <div className="row form-group field field-string foo">
          <div className="col">
            <div className="markdown">
              <p>
                An optional cover letter (or any other documents relevant to your application) can be uploaded here.
              </p>
            </div>
          </div>
        </div>
        <div className="form-group field field-object addln-object-single-row">
          <div className="row form-group">
            <label className="control-label col-md-5 addln-label" />
            <div className="col-md-7 additional-attachment">
              <fieldset id="academic" aria-labelledby="academic__description">
                <p id="academic__description" role="heading" aria-level="2" className="field-description">
                  Upload either DOC, DOCX, RTF, PDF, or TXT file types (1MB max)
                </p>
                <div className="form-group field field-null page2-or-text col-md-2">
                  <label className="control-label" htmlFor="academic.or_text" id="academic.or_text-label">
                    or
                  </label>
                </div>
                <div className="form-group field field-string page2-attach-file col-md-4">
                  <label className="control-label" htmlFor="academic.attach" id="academic.attach-label">
                    Select file
                  </label>
                  <div>
                    <label className="file-label" role="presentation" tabIndex="0">
                      <span className="title-text" />
                      <input
                        id="academic.attach"
                        type="file"
                        style={{ display: 'none' }}
                        onChange={(e) => setAttachments((all) => [...all, ...[...e.target.files].map((f) => f.name)])}
                      />
                    </label>
                  </div>
                </div>
              </fieldset>
            </div>
            <ul className="cover-letter-files-div" id="cover-letter-files-div">
              {attachments.map((a, k) => (
                <li key={k} className="pdf">
                  <a className="download-link pull-left" href="#!">
                    {a}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="row form-group field field-string markdown-as-header jsqheading">
          <div className="markdown">
            <p>Additional application questions</p>
          </div>
        </div>
        <Questionnaire answers={answers} set={(patch) => setAnswers((all) => ({ ...all, ...patch }))} />
        <div className="navigation workAndEducation-step">
          <button type="button" className="btn btn-navigate btn-prev" id="previous" aria-label="Previous">
            Previous
          </button>
          <button type="submit" className="btn btn-navigate btn-next" id="next" aria-label="Next">
            Next
          </button>
        </div>
      </form>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
createRoot(document.getElementById('root')).render(<App />);

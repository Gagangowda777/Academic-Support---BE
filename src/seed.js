require('dotenv').config();

const fs = require('fs');
const path = require('path');

const connectDB = require('./config/db');
const User = require('./models/User');
const Session = require('./models/Session');
const Subject = require('./models/Subject');
const Attendance = require('./models/Attendance');
const Attachment = require('./models/Attachment');
const MaterialAccess = require('./models/MaterialAccess');
const Exam = require('./models/Exam');
const SubjectPlan = require('./models/SubjectPlan');
const QuestionPaper = require('./models/QuestionPaper');
const { reevaluateExamPapers } = require('./services/paperService');
const { buildSessionResourcePdf } = require('./utils/resourcePdf');
const { UPLOAD_DIR } = require('./middleware/upload');

/**
 * Demo accounts, one per account type.
 * Passwords are hashed by the User model's pre-save hook (bcrypt, cost 12).
 */
const ACCOUNTS = [
  {
    name: 'Aarav Shetty',
    email: 'demo.student@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS014',
    department: 'Computer Science',
  },
  {
    name: 'Riya Nair',
    email: 'riya.nair@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS015',
    department: 'Computer Science',
  },
  {
    name: 'Karthik Reddy',
    email: 'karthik.reddy@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS016',
    department: 'Computer Science',
  },
  {
    name: 'Ananya Iyer',
    email: 'ananya.iyer@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS017',
    department: 'Computer Science',
  },
  {
    name: 'Mohammed Faiz',
    email: 'mohammed.faiz@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS018',
    department: 'Computer Science',
  },
  {
    name: 'Shreya Patil',
    email: 'shreya.patil@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2024CS019',
    department: 'Computer Science',
  },
  {
    name: 'Ishaan Verma',
    email: 'ishaan.verma@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2023CS041',
    department: 'Computer Science',
  },
  {
    name: 'Diya Menon',
    email: 'diya.menon@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2023CS042',
    department: 'Computer Science',
  },
  {
    name: 'Rahul Desai',
    email: 'rahul.desai@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2023CS043',
    department: 'Computer Science',
  },
  {
    name: 'Tanvi Kulkarni',
    email: 'tanvi.kulkarni@transcendgroup.org',
    password: 'Student@2026',
    role: 'student',
    enrollmentId: 'TRN2023CS044',
    department: 'Computer Science',
  },
  {
    name: 'Dr. Meera Kamath',
    email: 'faculty@transcendgroup.org',
    password: 'Faculty@2026',
    role: 'faculty',
    enrollmentId: null,
    department: 'Computer Science',
  },
  {
    name: 'Dr. Arjun Rao',
    email: 'faculty2@transcendgroup.org',
    password: 'Faculty@2026',
    role: 'faculty',
    enrollmentId: null,
    department: 'Computer Science',
  },
  {
    name: 'Prof. Rakesh Hegde',
    email: 'hod@transcendgroup.org',
    password: 'HodAdmin@2026',
    role: 'hod',
    enrollmentId: null,
    department: 'Computer Science',
  },
  {
    name: 'Sneha Rao',
    email: 'examcell@transcendgroup.org',
    password: 'ExamCell@2026',
    role: 'exam_cell',
    enrollmentId: null,
    department: 'Examination Cell',
  },
  {
    name: 'Vikram Bhat',
    email: 'academic@transcendgroup.org',
    password: 'AcadAdmin@2026',
    role: 'academic_admin',
    enrollmentId: null,
    department: 'Academic Office',
  },
  {
    name: 'Nandini Gowda',
    email: 'superadmin@transcendgroup.org',
    password: 'SuperAdmin@2026',
    role: 'super_admin',
    enrollmentId: null,
    department: 'Institution Administration',
  },
];

const CLASS_SESSIONS = [
  {
    courseCode: 'CS501',
    courseName: 'Database Management Systems',
    facultyName: 'Dr. Meera Kamath',
    date: '2026-11-05',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-204',
    topic: 'Query Optimisation & Indexing',
    status: 'absent',
    resource: {
      title: 'Indexing & Query Plans - Session Handout',
      fileName: 'CS501-indexing-and-query-plans.pdf',
      summary:
        'The planner picks the cheapest access path; a composite index only helps when its leading column is constrained.',
      objectives:
        'Read an execution plan, choose a composite index for an equality-plus-range predicate, and explain when an index costs more than it saves.',
      links: ['https://www.postgresql.org/docs/current/using-explain.html'],
      body: `Learning outcomes
- Read an EXPLAIN plan and identify a sequential scan.
- Choose a composite index whose leading column matches the equality predicate.
- Explain when an index makes a write-heavy workload slower.

Core ideas
1. A B-tree index stores keys in sorted order, so a range predicate becomes a bounded scan instead of a full table scan. The planner compares the estimated row count of each access path and picks the cheapest one.
2. Column order in a composite index matters. An index on (department, semester) serves a filter on department alone, but not on semester alone, because the leading column must be constrained.
3. Indexes are not free: each one adds write amplification and storage. On tables with heavy inserts keep the index set minimal and drop indexes no query uses.

Worked example
SELECT id, title FROM courses WHERE department = 'CSE' AND semester = 5 ORDER BY title;
With idx_courses(department, semester, title) the engine seeks to the matching leaf range and reads rows already sorted by title, so the sort step disappears.

Practice
- Run EXPLAIN ANALYZE for three queries on your project schema.
- Propose one index, then measure latency before and after.

Reading: chapter 8, sections 8.3 to 8.5.`,
    },
  },
  {
    courseCode: 'CS502',
    courseName: 'Operating Systems',
    facultyName: 'Prof. Rakesh Hegde',
    date: '2026-11-04',
    startTime: '11:00 AM',
    endTime: '12:00 PM',
    room: 'CS-208',
    topic: 'Deadlock Detection & Recovery',
    status: 'absent',
    resource: {
      title: 'Deadlock Detection - Worked Walkthrough',
      fileName: 'CS502-deadlock-detection.pdf',
      summary:
        'A cycle in the wait-for graph proves deadlock when each resource has a single instance.',
      objectives:
        'Build a wait-for graph from a resource allocation trace, detect cycles, and justify a recovery action.',
      links: ['https://pages.cs.wisc.edu/~remzi/OSTEP/'],
      body: `Concept
A deadlock needs four conditions at once: mutual exclusion, hold and wait, no preemption, and circular wait. Breaking any one of them makes deadlock impossible.

Wait-for graph method
Each process is a node. Draw an edge from Pi to Pj when Pi waits for a resource that Pj holds. A cycle in a single-instance graph means deadlock. For multiple instances per resource type, pair the cycle check with an available-resource check, or use the Banker's algorithm.

Worked trace
P1 holds R1 and requests R2. P2 holds R2 and requests R1. Edges P1 to P2 and P2 to P1 form a cycle, so the system is deadlocked. Recovery options: terminate P2, or preempt R2 from P2 and roll it back.

Prevention in practice
- A global ordering of lock acquisition removes circular wait.
- Lock timeouts allow recovery but are probabilistic.
- The Banker's algorithm avoids deadlock by refusing allocations that leave the system unsafe.

Exercise: build the wait-for graph for the trace on slide 14 and list every cycle.`,
    },
  },
  {
    courseCode: 'CS503',
    courseName: 'Computer Networks',
    facultyName: 'Dr. Ananya Rao',
    date: '2026-10-31',
    startTime: '10:00 AM',
    endTime: '11:00 AM',
    room: 'CS-110',
    topic: 'TCP Congestion Control',
    status: 'absent',
    resource: {
      title: 'TCP Congestion Control - Worked Examples',
      fileName: 'CS503-tcp-congestion-control.pdf',
      summary: 'AIMD produces the sawtooth: additive growth per RTT, multiplicative cut on loss.',
      objectives:
        'Trace slow start, congestion avoidance and fast recovery on a given cwnd and ssthresh timeline.',
      links: ['https://www.rfc-editor.org/rfc/rfc5681'],
      body: `Slow start
cwnd begins at one MSS and doubles every RTT until it reaches ssthresh. Growth is exponential, which is why short flows finish quickly.

Congestion avoidance
Above ssthresh, cwnd grows by roughly one MSS per RTT (additive increase). Loss is read as a congestion signal, so cwnd is halved (multiplicative decrease) - the classic AIMD sawtooth.

Example
Path with 100 ms RTT, MSS 1460 bytes, initial ssthresh 8 MSS. After four RTTs cwnd is 8 MSS, about 11680 bytes per RTT, or roughly 934 kbps. A loss on the next RTT sets ssthresh to 4 MSS and cwnd to 4 MSS.

Fast retransmit and recovery
Three duplicate ACKs imply a single lost segment rather than congestion collapse. Retransmit at once and enter fast recovery: halve ssthresh, inflate cwnd by the duplicate ACK count, and skip the return to slow start.

Contrast with delay-based approaches such as BBR, which model bottleneck bandwidth and RTT instead of reacting to loss.`,
    },
  },
  {
    courseCode: 'CS504',
    courseName: 'Software Engineering',
    facultyName: 'Dr. Meera Kamath',
    date: '2026-10-29',
    startTime: '02:00 PM',
    endTime: '03:00 PM',
    room: 'CS-201',
    topic: 'Agile Estimation & Velocity',
    status: 'absent',
    resource: null,
  },
  {
    courseCode: 'CS505',
    courseName: 'Design & Analysis of Algorithms',
    facultyName: 'Prof. Sanjay Kulkarni',
    date: '2026-10-27',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-104',
    topic: 'Dynamic Programming Patterns',
    status: 'absent',
    resource: {
      title: 'Dynamic Programming - Pattern Sheet',
      fileName: 'CS505-dynamic-programming-patterns.pdf',
      summary: 'Count states, then transitions per state - their product is the time complexity.',
      objectives:
        'Classify a new problem into a known dynamic programming pattern and state its time and space complexity.',
      links: ['https://cp-algorithms.com/dynamic_programming/intro-to-dp.html'],
      body: `How to recognise a DP problem
1. The answer can be built from answers to smaller subproblems.
2. Subproblems overlap, so memoisation or tabulation pays off.
3. A state can be described by a small tuple such as (index, capacity, last choice).

Core patterns
- 0/1 knapsack: iterate items, then capacity descending so each item is used once.
- Unbounded knapsack: iterate capacity ascending so an item can be reused.
- Longest common subsequence: a two-dimensional table over prefixes.
- Interval DP: interval length as the outer loop, split point as the inner loop.
- DP on trees: post-order merge of child states.

Template
for each state in topological order:
  best = base case
  for each transition:
    best = optimal(best, transition(dp[previous state]))
  dp[state] = best

Complexity checklist
Count the states, then count transitions per state. The product is the time complexity and the table size is the space. If only the previous layer is needed, reduce to O(n) space.

Practice set: coin change, edit distance, matrix chain multiplication, house robber on a tree.`,
    },
  },
  {
    courseCode: 'CS501',
    courseName: 'Database Management Systems',
    facultyName: 'Dr. Meera Kamath',
    date: '2026-11-03',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-204',
    topic: 'Normalisation & Functional Dependencies',
    status: 'present',
  },
  {
    courseCode: 'CS502',
    courseName: 'Operating Systems',
    facultyName: 'Prof. Rakesh Hegde',
    date: '2026-11-02',
    startTime: '11:00 AM',
    endTime: '12:00 PM',
    room: 'CS-208',
    topic: 'Scheduling Algorithms',
    status: 'present',
  },
  {
    courseCode: 'CS503',
    courseName: 'Computer Networks',
    facultyName: 'Dr. Ananya Rao',
    date: '2026-10-30',
    startTime: '10:00 AM',
    endTime: '11:00 AM',
    room: 'CS-110',
    topic: 'Reliable Transport Basics',
    status: 'present',
  },
  {
    courseCode: 'CS504',
    courseName: 'Software Engineering',
    facultyName: 'Dr. Meera Kamath',
    date: '2026-10-28',
    startTime: '02:00 PM',
    endTime: '03:00 PM',
    room: 'CS-201',
    topic: 'Requirements Elicitation',
    status: 'present',
  },
  {
    courseCode: 'CS505',
    courseName: 'Design & Analysis of Algorithms',
    facultyName: 'Prof. Sanjay Kulkarni',
    date: '2026-10-24',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-104',
    topic: 'Greedy Strategies',
    status: 'present',
  },
  {
    courseCode: 'CS506',
    courseName: 'Operating Systems',
    facultyName: 'Dr. Arjun Rao',
    date: '2026-11-05',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-208',
    topic: 'CPU Scheduling & Synchronisation',
    status: 'present',
    resource: null,
  },
  {
    courseCode: 'CS506',
    courseName: 'Operating Systems',
    facultyName: 'Dr. Arjun Rao',
    date: '2026-11-06',
    startTime: '09:00 AM',
    endTime: '10:00 AM',
    room: 'CS-208',
    topic: 'Memory Management & Paging',
    status: 'present',
    resource: null,
  },
];

const EXAMS = [
  {
    subjectCode: 'CS501',
    name: 'Internal Assessment 1',
    type: 'internal',
    date: '2026-10-20',
    startTime: '09:00',
    endTime: '10:00',
    room: 'CS-204',
    maxMarks: 20,
    passMarks: 8,
    status: 'completed',
    notes: 'Covers units 1 and 2. Marks already submitted to the department.',
  },
  {
    subjectCode: 'CS501',
    name: 'Mid-Semester Examination',
    type: 'mid_semester',
    date: '2026-11-12',
    startTime: '10:00',
    endTime: '11:30',
    room: 'CS-204',
    maxMarks: 50,
    passMarks: 20,
    status: 'scheduled',
    notes: 'Units 1 to 3. Section A only.',
  },
  {
    subjectCode: 'CS506',
    name: 'Quiz 1',
    type: 'quiz',
    date: '2026-11-10',
    startTime: '09:00',
    endTime: '09:30',
    room: 'CS-208',
    maxMarks: 20,
    passMarks: 8,
    status: 'scheduled',
    notes: 'Short quiz on process scheduling.',
  },
  {
    subjectCode: 'CS504',
    name: 'End-Semester Examination',
    type: 'end_semester',
    date: '2026-12-01',
    startTime: '09:00',
    endTime: '12:00',
    room: 'Exam Hall 1',
    maxMarks: 100,
    passMarks: 40,
    status: 'scheduled',
    notes: 'University theory paper. Hall ticket mandatory.',
  },
];

const SUBJECT_PLANS = [
  {
    subjectCode: 'CS501',
    syllabus: [
      {
        title: 'Relational model and SQL',
        topics: 'ER modelling, relational algebra, joins, subqueries and views.',
      },
      {
        title: 'Normalisation',
        topics: 'Functional dependencies, 1NF to BCNF, lossless decomposition.',
      },
      {
        title: 'Storage and indexing',
        topics: 'B-tree indexes, composite indexes, execution plans and query tuning.',
      },
      {
        title: 'Transactions and concurrency',
        topics: 'ACID, isolation levels, locking and recovery basics.',
      },
    ],
    components: [
      { name: 'Internal Assessment 1', maxMarks: 20 },
      { name: 'Internal Assessment 2', maxMarks: 20 },
      { name: 'End Semester', maxMarks: 60 },
    ],
    notes: 'Theory paper of 3 hours. Practical component assessed separately.',
  },
  {
    subjectCode: 'CS504',
    syllabus: [
      {
        title: 'Requirements engineering',
        topics: 'Elicitation, use cases, user stories and acceptance criteria.',
      },
      {
        title: 'Design and architecture',
        topics: 'Modularity, UML, architectural styles and design patterns.',
      },
      {
        title: 'Agile delivery',
        topics: 'Scrum, estimation, velocity and release planning.',
      },
      {
        title: 'Testing and quality',
        topics: 'Unit and integration testing, reviews, defect tracking.',
      },
    ],
    components: [
      { name: 'Internal Assessment 1', maxMarks: 20 },
      { name: 'Internal Assessment 2', maxMarks: 20 },
      { name: 'End Semester', maxMarks: 60 },
    ],
    notes: 'Project work carries 25% of the internal assessment.',
  },
  {
    subjectCode: 'CS506',
    syllabus: [
      {
        title: 'Processes and scheduling',
        topics: 'Process states, context switching, CPU scheduling algorithms.',
      },
      {
        title: 'Synchronisation',
        topics: 'Semaphores, monitors, deadlock detection and recovery.',
      },
      {
        title: 'Memory management',
        topics: 'Paging, segmentation, virtual memory and page replacement.',
      },
    ],
    components: [
      { name: 'Quiz', maxMarks: 10 },
      { name: 'Mid Semester', maxMarks: 20 },
      { name: 'End Semester', maxMarks: 70 },
    ],
    notes: '',
  },
];

const QUESTION_PAPERS = [
  {
    subjectCode: 'CS504',
    examName: 'End-Semester Examination',
    facultyEmail: 'faculty@transcendgroup.org',
    title: 'Set A — Board blueprint',
    questions: [
      {
        text: 'A hospital wants a patient-appointment module. Elicit two functional and two non-functional requirements, then write three acceptance criteria for the appointment-booking use case.',
        unit: 'Requirements engineering',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'apply',
        answerKey: 'Functional: search doctors by specialty and book or cancel a slot. Non-functional: booking must respond in under two seconds and protect patient data in transit. Acceptance criteria follow Given/When/Then for search, booking and cancellation.',
      },
      {
        text: 'Compare user stories with use cases for a payroll system and explain, with one example each, when a team should prefer one format over the other.',
        unit: 'Requirements engineering',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'understand',
        answerKey: 'User stories are short, negotiable placeholders for conversation and fit iterative delivery. Use cases describe actors, preconditions and main and alternate flows, so they suit complex interactions and contractual documentation. Payroll calculation suits a use case; a small UI preference suits a story.',
      },
      {
        text: 'Explain how modularity and information hiding reduce the ripple effect of change, using a layered architecture as an example.',
        unit: 'Design and architecture',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'understand',
        answerKey: 'Modules expose narrow interfaces and keep decisions private. A change to the storage engine stays inside the persistence layer because upper layers depend on the interface, not the implementation, which limits rework and regression risk.',
      },
      {
        text: 'Design a UML class diagram for a library lending system with at least five classes and relationships, and justify two design patterns you would apply.',
        unit: 'Design and architecture',
        marks: 10,
        difficulty: 'hard',
        cognitive: 'create',
        answerKey: 'Classes include Member, Book, Copy, Loan, Reservation and Fine with one-to-many associations. Use Strategy for loan duration rules and Observer for due-date notifications; both isolate variation behind stable interfaces.',
      },
      {
        text: 'Describe how story points differ from ideal hours and explain why velocity is meaningful only for a stable team.',
        unit: 'Agile delivery',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'understand',
        answerKey: 'Story points estimate relative effort, complexity and uncertainty, while ideal hours estimate elapsed work. Velocity is completed points per sprint and depends on estimation scale and team composition, so it is not comparable across teams.',
      },
      {
        text: 'A team completed 42 story points in sprint 4, 38 in sprint 5 and 40 in sprint 6. Calculate the average velocity and forecast how many sprints are needed for a 160-point backlog. State one assumption.',
        unit: 'Agile delivery',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'apply',
        answerKey: 'Average velocity is 40 points per sprint. At 40 points per sprint the backlog needs four sprints. This assumes scope, team size and definition of done stay stable and the backlog is refined.',
      },
      {
        text: 'Explain the purpose of the sprint review and sprint retrospective and state how each influences the next sprint.',
        unit: 'Agile delivery',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'The review inspects the increment with stakeholders and adapts the product backlog. The retrospective inspects the team process and produces improvement actions. Product direction and working agreements are updated accordingly.',
      },
      {
        text: 'Design a test strategy for a payment checkout feature covering unit, integration, system and acceptance levels. Include one non-functional test and the environment needed for each level.',
        unit: 'Testing and quality',
        marks: 10,
        difficulty: 'hard',
        cognitive: 'create',
        answerKey: 'Unit tests cover pricing rules with mocks; integration tests exercise the payment gateway contract in a sandbox; system tests run the full checkout in a staging environment; acceptance tests validate business scenarios with product owners. A load test checks throughput and latency under peak traffic.',
      },
      {
        text: 'Distinguish verification from validation and give one activity that belongs to each for a student-results portal.',
        unit: 'Testing and quality',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'understand',
        answerKey: 'Verification checks that the system is built correctly against specifications, for example a code review or unit test on the grade calculation. Validation checks that the right system was built, for example user acceptance testing of result publication with the examination cell.',
      },
      {
        text: 'Analyse this defect report: “Marks page crashes after saving.” Identify the missing fields and rewrite it as an actionable report with severity and priority.',
        unit: 'Testing and quality',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'analyze',
        answerKey: 'Missing build, environment, role, reproduction steps, expected and actual result, logs and test data. Rewritten report should include steps to reproduce, severity critical because data entry is blocked, and priority high before results submission.',
      },
    ],
  },
  {
    subjectCode: 'CS504',
    examName: 'End-Semester Examination',
    facultyEmail: 'faculty2@transcendgroup.org',
    title: 'Set B — Rapid revision',
    questions: [
      {
        text: 'What is requirements engineering?',
        unit: 'Requirements engineering',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'Requirements engineering is the process of eliciting, documenting and managing what a system must do.',
      },
      {
        text: 'What is a use case?',
        unit: 'Requirements engineering',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'What is a user story?',
        unit: 'Requirements engineering',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'A user story is a short description of a feature from the user perspective.',
      },
      {
        text: 'What is modularity?',
        unit: 'Design and architecture',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'What is a design pattern?',
        unit: 'Design and architecture',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'A design pattern is a reusable solution to a recurring design problem.',
      },
      {
        text: 'What is UML?',
        unit: 'Design and architecture',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'What is a sprint?',
        unit: 'Agile delivery',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'What is velocity?',
        unit: 'Agile delivery',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'Velocity is the amount of work a team completes in one sprint, measured in story points.',
      },
      {
        text: 'What is unit testing?',
        unit: 'Testing and quality',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'Unit testing checks a single small piece of code in isolation.',
      },
      {
        text: 'What is integration testing?',
        unit: 'Testing and quality',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
    ],
  },
  {
    subjectCode: 'CS501',
    examName: 'Mid-Semester Examination',
    facultyEmail: 'faculty@transcendgroup.org',
    title: 'Set A — Units 1 to 3',
    questions: [
      {
        text: 'Write an SQL query that lists each department with more than five students, showing the department name and student count, ordered by count descending.',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'apply',
        answerKey: 'SELECT department, COUNT(*) AS students FROM student GROUP BY department HAVING COUNT(*) > 5 ORDER BY students DESC;',
      },
      {
        text: 'Explain the difference between a natural join and a Cartesian product, using a two-table example.',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'understand',
        answerKey: 'A natural join matches rows on common attributes and removes duplicate columns. A Cartesian product pairs every row of one table with every row of the other, producing unrelated combinations.',
      },
      {
        text: 'Given R(A,B,C,D) with FDs AB to C, C to D and D to A, identify candidate keys and normalise the relation to BCNF. Show each decomposition and justify that it is lossless.',
        unit: 'Normalisation',
        marks: 10,
        difficulty: 'hard',
        cognitive: 'analyze',
        answerKey: 'Closure of AB gives A,B,C,D so AB is a candidate key; D to A makes DB a key and C to D makes CB a key. Decompose on the violating FDs until each determinant is a key, and use the common-attribute test to prove each join is lossless.',
      },
      {
        text: 'Define functional dependency and partial dependency and give one example of each.',
        unit: 'Normalisation',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'X to Y means each X value determines exactly one Y value. A partial dependency is a non-key attribute depending on part of a composite key, for example student_name depending on student_id within (student_id, course_id).',
      },
      {
        text: 'Compare B-tree and hash indexes for equality and range queries, and recommend one for a timestamp range filter.',
        unit: 'Storage and indexing',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'analyze',
        answerKey: 'Hash indexes give constant-time equality but cannot serve ordered ranges. B-trees keep keys ordered and support equality, range and ordered scans, so a B-tree is the right choice for a timestamp range.',
      },
    ],
  },
  {
    subjectCode: 'CS504',
    examName: 'End-Semester Examination',
    facultyEmail: 'faculty2@transcendgroup.org',
    title: 'Set C — Scenario paper',
    questions: [
      {
        text: 'A university wants a course-allocation system. Produce a requirements specification with two stakeholders, three functional requirements, two non-functional requirements and acceptance criteria for assigning a faculty member to a course.',
        unit: 'Requirements engineering',
        marks: 20,
        difficulty: 'easy',
        cognitive: 'apply',
        answerKey: 'Stakeholders: department head and faculty. Functional: create course, assign faculty, detect timetable clashes. Non-functional: role-based access and sub-second search. Acceptance criteria use Given/When/Then for a successful and a clashing assignment.',
      },
      {
        text: 'Design a layered architecture for a result-processing system and justify how the presentation, business and persistence layers isolate change. Include one UML component diagram description.',
        unit: 'Design and architecture',
        marks: 20,
        difficulty: 'medium',
        cognitive: 'create',
        answerKey: 'Presentation depends on a service interface; business rules own grade computation; persistence hides the database. A component diagram shows UI → ResultService → GradeCalculator and ResultRepository. Replacing the database affects only the repository.',
      },
      {
        text: 'A team delivered 36, 42 and 39 story points in three sprints and has a 195-point backlog. Calculate the average velocity, forecast the number of sprints, and explain two risks in that forecast.',
        unit: 'Agile delivery',
        marks: 20,
        difficulty: 'medium',
        cognitive: 'apply',
        answerKey: 'Average velocity is 39 points. The backlog needs five sprints. Risks: scope growth and team availability; estimates may also drift if the definition of done changes.',
      },
      {
        text: 'Design a risk-based test plan for an online examination portal covering security, load and recovery. Prioritise three risks and map each to a test technique and environment.',
        unit: 'Testing and quality',
        marks: 20,
        difficulty: 'hard',
        cognitive: 'evaluate',
        answerKey: 'Prioritise answer leakage, exam-time overload and data loss on crash. Use threat modelling and penetration tests for leakage, load tests in staging for capacity, and failover tests with backups for recovery. Rank by impact times likelihood.',
      },
      {
        text: 'Analyse how technical debt in a rapidly delivered student portal affects maintainability and testing. Recommend two repayment actions with a measurable outcome for each.',
        unit: 'Testing and quality',
        marks: 20,
        difficulty: 'medium',
        cognitive: 'analyze',
        answerKey: 'Debt raises change cost and regression risk. Actions: add automated regression tests around results and refactor the duplicated grade logic; measure escaped defects and lead time before and after.',
      },
    ],
  },
  {
    subjectCode: 'CS501',
    examName: 'Mid-Semester Examination',
    facultyEmail: 'faculty2@transcendgroup.org',
    title: 'Set C — Applied SQL and design',
    questions: [
      {
        text: 'Write SQL to report each course with its faculty name and enrolled student count, including courses with no enrolments. Explain why an outer join is required.',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'apply',
        answerKey: 'SELECT c.title, f.name, COUNT(e.student_id) FROM course c LEFT JOIN faculty f ON f.id = c.faculty_id LEFT JOIN enrolment e ON e.course_id = c.id GROUP BY c.id, c.title, f.name; The left join preserves courses without enrolments.',
      },
      {
        text: 'Given R(A,B,C,D,E) with FDs AB to C, C to D, D to E and E to A, compute the candidate keys and decompose the relation into 3NF. Justify each step.',
        unit: 'Normalisation',
        marks: 10,
        difficulty: 'hard',
        cognitive: 'analyze',
        answerKey: 'Closures: AB determines all attributes, so AB is a key; C determines A through D and E so BC and BD are also keys. Create relations for the violating FDs and verify a lossless join on the shared determinants.',
      },
      {
        text: 'Explain clustered versus non-clustered indexes and recommend an indexing strategy for a table queried by student_id and by date range.',
        unit: 'Storage and indexing',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'understand',
        answerKey: 'A clustered index defines physical row order and serves one ordering well; non-clustered indexes store pointers. Use a clustered index on date for range scans and a non-clustered index on student_id for lookups.',
      },
      {
        text: 'Explain the ACID properties and describe how a database recovers committed transactions after a crash using the write-ahead log.',
        unit: 'Transactions and concurrency',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'understand',
        answerKey: 'Atomicity, consistency, isolation and durability. The write-ahead log records changes before pages are flushed; recovery redoes committed transactions and undoes uncommitted ones.',
      },
      {
        text: 'Two transactions update the same account balance concurrently. Demonstrate a lost update and explain how row-level locking or optimistic concurrency prevents it.',
        unit: 'Transactions and concurrency',
        marks: 10,
        difficulty: 'medium',
        cognitive: 'apply',
        answerKey: 'Both read 100, add 20 and 30, and write 120 and 130; one update is lost. Row-level locking serialises the writes, or a version check rejects the stale write so it can retry.',
      },
    ],
  },
  {
    subjectCode: 'CS506',
    examName: 'Quiz 1',
    facultyEmail: 'faculty@transcendgroup.org',
    title: 'Set A — Scheduling and memory',
    questions: [
      {
        text: 'Compare preemptive and non-preemptive CPU scheduling and calculate the average waiting time for three processes under round robin with a quantum of four milliseconds.',
        unit: 'Processes and scheduling',
        marks: 7,
        difficulty: 'easy',
        cognitive: 'apply',
        answerKey: 'Preemptive scheduling can interrupt a running process, while non-preemptive scheduling runs it to completion or block. Simulate the ready queue in quantum slices and average each process waiting time.',
      },
      {
        text: 'Explain how a counting semaphore protects a bounded buffer shared by a producer and a consumer, including the wait and signal order that avoids deadlock.',
        unit: 'Synchronisation',
        marks: 7,
        difficulty: 'easy',
        cognitive: 'understand',
        answerKey: 'Use empty and full semaphores plus a mutex. The producer waits on empty before inserting and signals full; the consumer waits on full before removing and signals empty. Acquire the resource semaphore before the mutex to avoid deadlock.',
      },
      {
        text: 'Compare FIFO and LRU page replacement on a reference string with three frames and identify which algorithm avoids Belady anomaly.',
        unit: 'Memory management',
        marks: 6,
        difficulty: 'medium',
        cognitive: 'remember',
        answerKey: 'Simulate both algorithms and count faults. FIFO can increase faults when frames increase, so it shows Belady anomaly; LRU is a stack algorithm and does not.',
      },
    ],
  },
  {
    subjectCode: 'CS506',
    examName: 'Quiz 1',
    facultyEmail: 'faculty2@transcendgroup.org',
    title: 'Set B — Quick definitions',
    questions: [
      {
        text: 'What is a process?',
        unit: 'Processes and scheduling',
        marks: 5,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'A process is a program in execution with its own address space and state.',
      },
      {
        text: 'What is a thread?',
        unit: 'Processes and scheduling',
        marks: 5,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'What is a semaphore?',
        unit: 'Synchronisation',
        marks: 5,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'A semaphore is a synchronisation variable with wait and signal operations.',
      },
      {
        text: 'What is virtual memory?',
        unit: 'Memory management',
        marks: 5,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
    ],
  },
  {
    subjectCode: 'CS501',
    examName: 'Mid-Semester Examination',
    facultyEmail: 'faculty2@transcendgroup.org',
    title: 'Set B — Definitions',
    questions: [
      {
        text: 'What is SQL?',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'SQL is the structured query language used to define and query relational databases.',
      },
      {
        text: 'What is a primary key?',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
      {
        text: 'Explain first normal form with an example.',
        unit: 'Normalisation',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'understand',
        answerKey: 'A relation is in 1NF when every attribute holds a single atomic value; repeating groups such as phone numbers in one column are removed into a separate table.',
      },
      {
        text: 'What is a functional dependency?',
        unit: 'Normalisation',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: 'A functional dependency X to Y means each value of X determines exactly one value of Y.',
      },
      {
        text: 'List the types of joins in SQL.',
        unit: 'Relational model and SQL',
        marks: 10,
        difficulty: 'easy',
        cognitive: 'remember',
        answerKey: '',
      },
    ],
  },
];

const SUBJECTS = [
  {
    code: 'CS501',
    name: 'Database Management Systems',
    academicYear: '2026-27',
    batch: '2024-2028',
    section: 'A',
    facultyEmail: 'faculty@transcendgroup.org',
  },
  {
    code: 'CS504',
    name: 'Software Engineering',
    academicYear: '2026-27',
    batch: '2024-2028',
    section: 'A',
    facultyEmail: 'faculty@transcendgroup.org',
  },
  {
    code: 'CS506',
    name: 'Operating Systems',
    academicYear: '2026-27',
    batch: '2023-2027',
    section: 'B',
    facultyEmail: 'faculty2@transcendgroup.org',
  },
];

function batchForEnrollment(enrollmentId) {
  const match = /^TRN(\d{4})/.exec(String(enrollmentId || ''));
  if (!match) return null;

  const start = Number(match[1]);
  return `${start}-${start + 4}`;
}

/** Assigns each demo subject to the faculty member recorded on it. */
async function seedSubjects(facultyByEmail) {
  const subjects = new Map();

  for (const definition of SUBJECTS) {
    const { facultyEmail, ...fields } = definition;
    const faculty = facultyByEmail.get(facultyEmail);

    if (!faculty) continue;

    const subject = await Subject.findOneAndUpdate(
      {
        code: fields.code,
        academicYear: fields.academicYear,
        section: fields.section,
      },
      {
        $set: {
          ...fields,
          department: 'Computer Science',
          semester: 5,
          faculty: faculty._id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    subjects.set(subject.code, subject);
  }

  console.log(`[seed] ${subjects.size} subjects assigned across ${facultyByEmail.size} faculty`);
  return subjects;
}

/**
 * Seeds the timetable, attendance, materials and their real attachment files.
 * Sessions are keyed on course + date, attendance on session + student and
 * seeded attachments on their stored name, so re-running updates in place.
 */
async function seedStudentAcademics(student, classmates, faculty, subjectsByCode) {
  let upserted = 0;
  let files = 0;
  const seededSessions = [];

  for (const definition of CLASS_SESSIONS) {
    const { status, resource, ...sessionFields } = definition;
    const date = new Date(`${definition.date}T00:00:00.000Z`);
    const subject = subjectsByCode.get(definition.courseCode) || null;
    // Sessions without a subject document belong to the demo cohort.
    const sessionBatch = subject ? subject.batch : '2024-2028';

    const session = await Session.findOneAndUpdate(
      { courseCode: definition.courseCode, date },
      {
        $set: {
          ...sessionFields,
          date,
          semester: 5,
          department: 'Computer Science',
          subject: subject ? subject._id : null,
          status: 'completed',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (resource) {
      const storedName = `seed-${session.courseCode}-${definition.date}.pdf`;
      const pdf = await buildSessionResourcePdf({
        session,
        student,
        resource: { title: resource.title, body: resource.body, summary: resource.summary },
      });

      await fs.promises.writeFile(path.join(UPLOAD_DIR, storedName), pdf);

      const attachment = await Attachment.findOneAndUpdate(
        { storedName },
        {
          $set: {
            session: session._id,
            originalName: resource.fileName,
            mimeType: 'application/pdf',
            size: pdf.length,
            kind: 'document',
            uploadedBy: subject ? faculty._id : null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      session.material = {
        title: resource.title,
        description: resource.summary,
        objectives: resource.objectives || '',
        links: resource.links || [],
        uploadedAt: new Date(`${definition.date}T12:30:00.000Z`),
        uploadedBy: subject ? faculty._id : null,
      };
      await session.save();

      files += 1;
    }

    // The demo student belongs to the 2024-2028 cohort; sessions for other
    // batches must not leak into their own attendance history.
    if (sessionBatch === '2024-2028') {
      await Attendance.findOneAndUpdate(
        { session: session._id, student: student._id },
        {
          $set: { status, markedAt: new Date(`${definition.date}T10:15:00.000Z`) },
          $setOnInsert: { reviewedAt: null },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      upserted += 1;
    }

    seededSessions.push({ session, date: definition.date, batch: sessionBatch });
  }

  // Classmates give the faculty view realistic present/absent counts. Each one
  // misses one or two sessions on a fixed pattern so the numbers stay stable
  // across seed runs.
  let records = 0;

  for (const [sessionIndex, entry] of seededSessions.entries()) {
    for (const [studentIndex, classmate] of classmates.entries()) {
      const studentBatch = batchForEnrollment(classmate.enrollmentId);

      // Only mark students who actually sit in that batch's class.
      if (studentBatch !== entry.batch) continue;

      const absent = (sessionIndex + studentIndex + 1) % 6 === 0;

      await Attendance.findOneAndUpdate(
        { session: entry.session._id, student: classmate._id },
        {
          $set: {
            status: absent ? 'absent' : 'present',
            markedAt: new Date(`${entry.date}T10:15:00.000Z`),
          },
          $setOnInsert: { reviewedAt: null },
        },
        { upsert: true, setDefaultsOnInsert: true }
      );

      records += 1;
    }
  }

  // Seed real access rows for the HOD access-rate report. Absent students are
  // the audience for the seeded material; every fourth eligible student is
  // deliberately left out so the dashboard demonstrates a rate below 100%.
  let accesses = 0;
  let attachmentIndex = 0;
  const analyticsSessions = await Session.find({
    subject: { $in: [...subjectsByCode.values()].map((subject) => subject._id) },
    'material.title': { $nin: [null, ''] },
    'material.visibility': { $ne: 'draft' },
  }).lean();

  for (const session of analyticsSessions) {
    const files = await Attachment.find({ session: session._id }).select('_id').lean();
    const absentRecords = await Attendance.find({
      session: session._id,
      status: 'absent',
    })
      .select('student')
      .lean();
    const uploadedAt = session.material?.uploadedAt
      ? new Date(session.material.uploadedAt)
      : session.date;

    for (const file of files) {
      for (const [studentIndex, record] of absentRecords.entries()) {
        if ((attachmentIndex + studentIndex) % 4 === 0) continue;

        const accessedAt = new Date(uploadedAt.getTime() + (6 + studentIndex) * 60 * 60 * 1000);

        await MaterialAccess.findOneAndUpdate(
          { attachment: file._id, student: record.student },
          {
            $set: {
              session: session._id,
              downloads: 1 + (studentIndex % 2),
              previews: (attachmentIndex + studentIndex) % 2,
              firstAccessedAt: accessedAt,
              lastAccessedAt: accessedAt,
            },
          },
          { upsert: true, setDefaultsOnInsert: true }
        );

        accesses += 1;
      }
      attachmentIndex += 1;
    }
  }

  const absent = CLASS_SESSIONS.filter((item) => item.status === 'absent').length;
  console.log(
    `[seed] ${upserted} class sessions for ${student.email} (${absent} absences, ${files} material files)`
  );
  console.log(`[seed] ${records} attendance records for ${classmates.length} classmates`);
  console.log(`[seed] ${accesses} material access records for department analytics`);
}

async function seedExams(subjectsByCode, examCellUser) {
  let exams = 0;
  let plans = 0;

  for (const definition of EXAMS) {
    const subject = subjectsByCode.get(definition.subjectCode);
    if (!subject) continue;

    const { subjectCode, date, ...fields } = definition;

    await Exam.findOneAndUpdate(
      { subject: subject._id, name: fields.name },
      {
        $set: {
          ...fields,
          date: new Date(`${date}T00:00:00.000Z`),
          subject: subject._id,
          updatedBy: examCellUser._id,
        },
        $setOnInsert: { createdBy: examCellUser._id },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    exams += 1;
  }

  for (const definition of SUBJECT_PLANS) {
    const subject = subjectsByCode.get(definition.subjectCode);
    if (!subject) continue;

    await SubjectPlan.findOneAndUpdate(
      { subject: subject._id },
      {
        $set: {
          syllabus: definition.syllabus,
          components: definition.components,
          notes: definition.notes,
          updatedBy: examCellUser._id,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    plans += 1;
  }

  console.log(`[seed] ${exams} exams and ${plans} syllabus/marks plans`);
}

/** Demo paper sets from two faculty members so the AI comparison has data. */
async function seedQuestionPapers(subjectsByCode, facultyByEmail) {
  let papers = 0;
  const examIds = new Set();

  for (const definition of QUESTION_PAPERS) {
    const subject = subjectsByCode.get(definition.subjectCode);
    const faculty = facultyByEmail.get(definition.facultyEmail);
    if (!subject || !faculty) continue;

    const exam = await Exam.findOne({ subject: subject._id, name: definition.examName });
    if (!exam) continue;

    await Exam.updateOne(
      { _id: exam._id },
      { $set: { approvedPaper: null, approvedAt: null, approvedBy: null } }
    );

    const totalMarks = definition.questions.reduce((sum, question) => sum + question.marks, 0);

    await QuestionPaper.findOneAndUpdate(
      { exam: exam._id, faculty: faculty._id, title: definition.title },
      {
        $set: {
          subject: subject._id,
          questions: definition.questions,
          totalMarks,
          status: 'submitted',
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: '',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    examIds.add(exam._id.toString());
    papers += 1;
  }

  for (const examId of examIds) {
    await reevaluateExamPapers(examId);
  }

  console.log(`[seed] ${papers} question-paper sets evaluated across ${examIds.size} exams`);
}

async function seed() {
  try {
    await connectDB();

    for (const account of ACCOUNTS) {
      const existing = await User.findOne({ email: account.email });

      if (existing) {
        existing.set({
          name: account.name,
          role: account.role,
          enrollmentId: account.enrollmentId,
          department: account.department,
          isActive: true,
          password: account.password,
        });
        await existing.save();
        console.log(`[seed] updated ${account.role.padEnd(15)} ${account.email}`);
      } else {
        await User.create(account);
        console.log(`[seed] created ${account.role.padEnd(15)} ${account.email}`);
      }
    }

    const demoStudent = await User.findOne({ email: 'demo.student@transcendgroup.org' });
    const demoFaculty = await User.findOne({ email: 'faculty@transcendgroup.org' });
    const secondFaculty = await User.findOne({ email: 'faculty2@transcendgroup.org' });

    const facultyByEmail = new Map();
    if (demoFaculty) facultyByEmail.set(demoFaculty.email, demoFaculty);
    if (secondFaculty) facultyByEmail.set(secondFaculty.email, secondFaculty);

    const classmates = await User.find({
      role: 'student',
      email: { $ne: 'demo.student@transcendgroup.org' },
    }).sort({ email: 1 });

    if (demoStudent && demoFaculty) {
      const subjectsByCode = await seedSubjects(facultyByEmail);
      await seedStudentAcademics(demoStudent, classmates, demoFaculty, subjectsByCode);

      const examCellUser = await User.findOne({ email: 'examcell@transcendgroup.org' });
      if (examCellUser) {
        await seedExams(subjectsByCode, examCellUser);
        await seedQuestionPapers(subjectsByCode, facultyByEmail);
      }
    }

    console.log('\n[seed] done. Demo credentials:');
    for (const account of ACCOUNTS) {
      console.log(`  ${account.role.padEnd(15)} ${account.email}  ${account.password}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('[seed] failed:', error.message);
    process.exit(1);
  }
}

seed();

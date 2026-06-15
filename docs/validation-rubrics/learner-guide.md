# Learner Guide: Run a Lab Validation Rubric

Use this guide after you complete a CopilotStudioLabs build lab.

## What you need

- Your completed Copilot Studio agent
- The rubric YAML for the lab
- The lab's `.testset.csv` file
- Access to the **Evaluation** feature in Copilot Studio

> Agent Evaluation is a Copilot Studio preview feature. If you do not see **Evaluation**, ask your instructor or tenant administrator whether the feature is enabled and available in your region.

## 1. Open your completed agent

1. Go to <https://copilotstudio.microsoft.com>.
2. Open the agent you built for the lab.
3. Confirm the required knowledge sources, topics, tools, flows, or connected agents are present and ready.
4. Open **Evaluation** in the agent's top navigation.

## 2. Import the test set CSV

1. Select **Create a test set**.
2. Choose **CSV** under the upload/start options.
3. Upload the lab's `.testset.csv` file.
4. Name the test set using the name in the rubric, such as `Lab 01 — Energy Ops Validation`.
5. Save the test set.

The CSV includes `question` and `expectedResponse` columns. Copilot Studio uses those fields with the test methods you configure after import.

## 3. Configure test methods

Open the rubric YAML and configure the methods it recommends. Common choices are:

- **General quality** for open-ended quality and safety judgment
- **Compare meaning** when the expected response describes the same meaning in different words
- **Keyword match** when required phrases or caveats must appear
- **Exact match** when exact terms are mandatory
- **Capability use** when a topic, tool, flow, or action must run
- **Custom** when your instructor has provided a custom evaluator

If the rubric includes knowledge-source or tool evidence, you will review the activity map after the run.

## 4. Run the evaluation

1. Select the user profile that should run the evaluation.
2. Select **Evaluate**.
3. Wait for the run to complete. Lab 02 notes that small sets often take a few minutes.
4. Open the results.

## 5. Interpret your score

Check:

- Overall pass rate
- Failed cases
- Evaluator reasoning
- Actual response
- Knowledge citations and source evidence
- Activity map showing which knowledge sources, topics, tools, or actions were used

A high-quality result should both answer correctly and show evidence that the agent used the expected grounding or capability.

## 6. Fix and rerun

If you fail a case:

1. Read the expected behavior in the rubric.
2. Check whether the agent missed knowledge, gave an unsafe answer, failed to ask for missing details, or used the wrong topic/tool.
3. Fix the agent instructions, source descriptions, knowledge sources, topic descriptions, or tool descriptions.
4. Re-run the same test set.
5. Use **Compare with** to confirm your change improved the result without regressions.

## 7. Export completion evidence

When you pass:

1. Select **Export test results**.
2. Save the export using a clear name that includes lab ID, your name or initials, agent name, test set name, and run date.
3. Submit the export to your instructor if required.

Remember: for safety, compliance, PII, and access-control cases, a single critical failure can block completion even if the overall score is high.

import joblib
from flask import Flask, jsonify, request

app = Flask(__name__)

@app.route("/predict", methods=["POST"])
def predict():
    model = joblib.load("linear_regression_model.joblib")  # Assuming the trained model file is named trained_model.pkl
    data = request.json["data"]
    prediction = model.predict(data)
    return jsonify({"prediction": prediction.tolist()})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
